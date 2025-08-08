// pages/api/cotacao.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import { decode } from 'html-entities';

type SswOk = {
  ok: true;
  valorFrete: number;
  prazoEntrega: number;
  numeroCotacao: string;
  token?: string;
  mensagem: string;
  lastRequest: string;
};

type SswErr = {
  error: string;
  details?: string;
  ssw?: any;
  detalhes?: any;
  sentArgs?: any;
  lastRequest?: string;
  debug?: any;
};

const SSW_ENDPOINT = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php';
const SSW_NS = 'urn:sswinfbr.sswCotacaoColeta';

// -------- helpers --------
const onlyDigits = (v: any) => (v ?? '').toString().replace(/\D+/g, '');
const toDec = (v: any, d = 3) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? undefined : +n.toFixed(d);
};
const toInt = (v: any) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseInt(String(v).trim(), 10);
  return isNaN(n) ? undefined : n;
};
const zeroPadCpfCnpj = (doc: any) => {
  const d = onlyDigits(doc);
  if (!d) return '';
  return d.length === 11 ? d.padStart(14, '0') : d;
};

// parser robusto do SOAP (tolera ausência/variação do <return>)
function extractReturnFromSoap(soapXml: string) {
  if (!soapXml || typeof soapXml !== 'string') return { returnXml: null, debug: { reason: 'empty_soap' } };

  // <return> com ou sem namespace
  let m = soapXml.match(/<([\w:]*?)return\b[^>]*>([\s\S]*?)<\/\1return>/i);
  if (m && m[2]) {
    return { returnXml: decode(m[2].trim()), debug: { path: 'return' } };
  }

  // corpo do cotarSiteResponse
  let r = soapXml.match(/<([\w:]*?)cotarSiteResponse\b[^>]*>([\s\S]*?)<\/\1cotarSiteResponse>/i);
  if (r && r[2]) {
    const inner = decode(r[2].trim());
    m = inner.match(/<([\w:]*?)return\b[^>]*>([\s\S]*?)<\/\1return>/i);
    if (m && m[2]) {
      return { returnXml: decode(m[2].trim()), debug: { path: 'response.return' } };
    }
    const c = inner.match(/<cotacao>[\s\S]*?<\/cotacao>/i);
    if (c && c[0]) {
      return { returnXml: c[0], debug: { path: 'response.cotacao' } };
    }
  }

  // fallback: qualquer <cotacao>
  const c2 = soapXml.match(/<cotacao>[\s\S]*?<\/cotacao>/i);
  if (c2 && c2[0]) {
    return { returnXml: c2[0], debug: { path: 'global.cotacao' } };
  }

  return {
    returnXml: null,
    debug: { reason: 'no_return_node', soapPreview: soapXml.slice(0, 600) },
  };
}

function buildSoapEnvelope(args: Record<string, string>) {
  // monta o XML exatamente na ordem esperada pela SSW
  const params = Object.entries(args)
    .map(([k, v]) => `<${k}>${v ?? ''}</${k}>`)
    .join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"  xmlns:tns="${SSW_NS}">
  <soap:Body>
    <tns:cotarSite>
      ${params}
    </tns:cotarSite>
  </soap:Body>
</soap:Envelope>`;
}

function parseCotacaoXml(xml: string) {
  const get = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].trim() : '';
  };
  const erro = get('erro');
  const mensagem = get('mensagem');
  const frete = get('frete').replace('.', '').replace(',', '.'); // "159,77" -> "159.77"
  const prazo = get('prazo');
  const cotacao = get('cotacao');
  const token = get('token');

  return {
    erro: erro ? parseInt(erro, 10) : 1,
    mensagem,
    frete: frete ? parseFloat(frete) : 0,
    prazo: prazo ? parseInt(prazo, 10) : 0,
    cotacao,
    token,
  };
}

// -------- handler --------
export default async function handler(req: NextApiRequest, res: NextApiResponse<SswOk | SswErr>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const b = (req.body ?? {}) as Record<string, any>;

    // normalização mínima (a API pública aceita valorMercadoria; internamente enviamos como valorNF)
    const valorMercadoria = b.valorMercadoria ?? b.valorNF;
    const quantidade = toInt(b.quantidade) ?? 1;
    const peso = toDec(b.peso, 3);
    const volume = toDec(b.volume, 4);
    const altura = toDec(b.altura, 3);
    const largura = toDec(b.largura, 3);
    const comprimento = toDec(b.comprimento, 3);

    // documentos
    const cnpjPagador = zeroPadCpfCnpj(b.cnpjPagador);
    let cnpjRemetente = zeroPadCpfCnpj(b.cnpjRemetente);
    let cnpjDestinatario = zeroPadCpfCnpj(b.cnpjDestinatario);

    // CIF/FOB
    const tf = (b.ciffob || '').toString().trim().toLowerCase();
    const ciffob = tf === 'c' || tf === 'cif' ? 'C' : 'F';

    // regras de fallback
    if (ciffob === 'C' && !onlyDigits(cnpjRemetente)) cnpjRemetente = cnpjPagador;
    if (ciffob === 'F' && !onlyDigits(cnpjDestinatario)) cnpjDestinatario = cnpjPagador;

    // coletar (default 'N' se não vier; você pediu 'S' — respeitamos o que vier do cliente)
    const coletar = (b.coletar || 'N').toString().trim().toUpperCase() === 'S' ? 'S' : 'N';

    // validações mínimas da entrada pública
    const missing: string[] = [];
    if (!onlyDigits(cnpjPagador)) missing.push('cnpjPagador é obrigatório');
    if (!onlyDigits(b.cepOrigem)) missing.push('cepOrigem é obrigatório');
    if (!onlyDigits(b.cepDestino)) missing.push('cepDestino é obrigatório');

    const vMercNum = parseFloat(String(valorMercadoria ?? '0').replace(',', '.'));
    if (!vMercNum || vMercNum <= 0) missing.push('valorMercadoria deve ser > 0');

    if ((!peso || peso <= 0) && (!volume || volume <= 0)) {
      missing.push('informe peso (>0) ou volume (>0)');
    }

    if (missing.length) {
      return res.status(400).json({
        error: 'Entrada inválida',
        details: missing.join('; '),
      });
    }

    // monta os argumentos que vão no SOAP (nomes esperados pela SSW)
    const sentArgs = {
      dominio: 'OST',
      login: 'cotawa',
      senha: '123456',

      cnpjPagador,
      senhaPagador: b.senhaPagador ?? '1234',

      cepOrigem: onlyDigits(b.cepOrigem),
      cepDestino: onlyDigits(b.cepDestino),

      valorNF: vMercNum.toFixed(2),
      quantidade: quantidade,
      peso: (peso ?? 0).toFixed(3),
      volume: (volume ?? 0).toFixed(4),

      mercadoria: parseInt(b.mercadoria || 1, 10),
      ciffob,

      cnpjRemetente,
      cnpjDestinatario,

      observacao: b.observacao || '',

      // extras (enviados mesmo vazios)
      trt: b.trt || '',
      coletar,
      entDificil: b.entDificil || '',
      destContribuinte: b.destContribuinte || '',
      qtdePares: b.qtdePares || '',

      altura: (altura ?? 0).toFixed(3),
      largura: (largura ?? 0).toFixed(3),
      comprimento: (comprimento ?? 0).toFixed(3),

      fatorMultiplicador: b.fatorMultiplicador || '',
    } as Record<string, any>;

    // o SOAP da SSW espera strings em vários campos — normaliza aqui
    const argsAsString: Record<string, string> = Object.fromEntries(
      Object.entries(sentArgs).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)])
    );

    const soapEnvelope = buildSoapEnvelope(argsAsString);

    const fetchResp = await fetch(SSW_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `${SSW_NS}#cotarSite`,
      },
      body: soapEnvelope,
    });

    const soapText = await fetchResp.text();

    const { returnXml, debug } = extractReturnFromSoap(soapText);

    if (!returnXml) {
      return res.status(502).json({
        error: 'Erro ao consultar cotação na SSW',
        details: 'Resposta SOAP sem nó <return>',
        debug,
        sentArgs,
        lastRequest: soapEnvelope,
      });
    }

    const result = parseCotacaoXml(returnXml);

    if (result.erro && result.erro !== 0) {
      return res.status(422).json({
        error: 'SSW retornou erro',
        ssw: { erro: result.erro, mensagem: result.mensagem },
        detalhes: { cotacaoXml: returnXml },
        sentArgs,
        lastRequest: soapEnvelope,
      });
    }

    return res.status(200).json({
      ok: true,
      valorFrete: result.frete,
      prazoEntrega: result.prazo,
      numeroCotacao: returnXml.replace(/\s+/g, ' ').trim(), // devolvemos bruto para você decidir
      token: result.token,
      mensagem: result.mensagem || 'OK',
      lastRequest: soapEnvelope,
    });
  } catch (e: any) {
    return res.status(500).json({
      error: 'FUNCTION_INVOCATION_FAILED',
      message: e?.message || String(e),
    });
  }
}
