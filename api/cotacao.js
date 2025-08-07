import { createClientAsync } from 'soap';

// ---- Helpers ----
const toStr = v => (v ?? '').toString().trim();
const dec = v => {
  if (v === undefined || v === null || v === '') return null;
  const s = toStr(v).replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const int = v => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(toStr(v).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
// formata para string PT-BR, sempre com 2 casas: 23 -> "23,00", 0.27 -> "0,27"
const fmtPt2 = (n) => {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toFixed(2).replace('.', ',');
};
const fmtIntStr = (n) => {
  const v = int(n);
  return Number.isFinite(v) ? String(v) : '';
};

// ---- Sanitização / validação ----
function sanitizeCotacaoInput(raw) {
  const i = { ...raw };

  // credenciais fixas
  i.dominio = 'OST';
  i.login = 'cotawa';
  i.senha = '123456';
  i.senhaPagador = '1234';

  // campos do body
  i.cnpjPagador = toStr(i.cnpjPagador).replace(/\D/g, '');
  i.cnpjRemetente = toStr(i.cnpjRemetente).replace(/\D/g, '');
  i.cnpjDestinatario = toStr(i.cnpjDestinatario).replace(/\D/g, '');
  i.cepOrigem = toStr(i.cepOrigem).replace(/\D/g, '');
  i.cepDestino = toStr(i.cepDestino).replace(/\D/g, '');

  i.valorNF = dec(i.valorNF) ?? dec(i.valorMercadoria) ?? 0;
  i.quantidade = int(i.quantidade) ?? int(i.quantidadeVolumes) ?? 1;
  i.peso = dec(i.peso) ?? 0;
  i.volume = dec(i.volume);

  i.altura = dec(i.altura);
  i.largura = dec(i.largura);
  i.comprimento = dec(i.comprimento);

  // calcula volume se não veio mas dimensões vieram (m3)
  if (!(i.volume > 0) && [i.altura, i.largura, i.comprimento].every(v => typeof v === 'number' && v > 0)) {
    i.volume = Number((i.altura * i.largura * i.comprimento * (i.quantidade || 1)).toFixed(4));
  }

  i.mercadoria = toStr(i.mercadoria) || '1';
  i.ciffob = toStr(i.ciffob || i.cifFob).toUpperCase().replace(/[^CF]/g, '').charAt(0) || 'F';
  i.observacao = toStr(i.observacao).slice(0, 195);

  return i;
}

function validateForSSW(i) {
  const erros = [];
  if (!i.cnpjPagador) erros.push('cnpjPagador é obrigatório');
  if (!i.cepOrigem) erros.push('cepOrigem é obrigatório');
  if (!i.cepDestino) erros.push('cepDestino é obrigatório');
  if ((i.valorNF ?? 0) <= 0) erros.push('valorNF deve ser > 0');
  if ((i.peso ?? 0) <= 0 && (i.volume ?? 0) <= 0) erros.push('informe peso (>0) ou volume (>0)');
  if (!['C', 'F'].includes(i.ciffob)) erros.push('ciffob deve ser C ou F');
  if (erros.length) {
    const e = new Error(erros.join('; '));
    e.status = 400;
    throw e;
  }
  return i;
}

// ---- Parse XML ----
const extractCotacaoXml = text => {
  if (!text) return null;
  const m = String(text).match(/<cotacao[\s\S]*?<\/cotacao>/i);
  return m ? m[0] : null;
};
const getTag = (xml, name) => {
  if (!xml) return null;
  const re = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i');
  const mm = xml.match(re);
  return mm ? mm[1].trim() : null;
};
const decFromPt = s => {
  if (!s) return null;
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// ---- Handler ----
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const mapped = {
    dominio: 'OST',
    login: 'cotawa',
    senha: '123456',
    senhaPagador: '1234',

    cnpjPagador: raw.cnpjPagador,
    cepOrigem: raw.cepOrigem,
    cepDestino: raw.cepDestino,
    valorNF: raw.valorMercadoria,
    quantidade: raw.quantidadeVolumes,
    peso: raw.peso,
    volume: raw.volume,
    mercadoria: raw.mercadoria ?? '1',
    ciffob: raw.ciffob,
    observacao: raw.observacao,
    cnpjRemetente: raw.remetente?.cnpj,
    cnpjDestinatario: raw.destinatario?.cnpj,
    altura: raw.altura,
    largura: raw.largura,
    comprimento: raw.comprimento,
    tipoFrete: raw.tipoFrete || '',
    tipoEntrega: raw.tipoEntrega || '',
  };

  let input;
  try {
    input = validateForSSW(sanitizeCotacaoInput(mapped));
  } catch (err) {
    return res.status(err.status || 400).json({ error: 'Entrada inválida', details: err.message });
  }

  // monta args COMO STRINGS no formato que o SSW espera (PT-BR)
  const soapArgs = {
    dominio: input.dominio,                     // string
    login: input.login,                         // string
    senha: input.senha,                         // string
    cnpjPagador: input.cnpjPagador,             // string só dígitos
    senhaPagador: input.senhaPagador,           // string
    cepOrigem: input.cepOrigem,                 // string
    cepDestino: input.cepDestino,               // string
    valorNF: fmtPt2(input.valorNF),             // "1500,00"
    quantidade: fmtIntStr(input.quantidade),    // "1"
    peso: fmtPt2(input.peso),                   // "23,00"  <<<<<<<<<<<<<<<<<<<<<<
    volume: input.volume > 0 ? fmtPt2(input.volume) : "", // "0,27" ou ""
    mercadoria: '1',                            // sempre 1
    ciffob: input.ciffob,                       // "F" ou "C"
    observacao: input.observacao,               // string
    cnpjRemetente: input.cnpjRemetente || "",   // string
    cnpjDestinatario: input.cnpjDestinatario || "", // string
    altura: input.altura ? fmtPt2(input.altura) : "", // "0,45"
    largura: input.largura ? fmtPt2(input.largura) : "", // "0,60"
    comprimento: input.comprimento ? fmtPt2(input.comprimento) : "", // "1,00"
    // tipoFrete/tipoEntrega: enviar só se realmente usados; senão, vazio:
    tipoFrete: input.tipoFrete || "",
    tipoEntrega: input.tipoEntrega || ""
  };

  try {
    const soapUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';
    const client = await createClientAsync(soapUrl);
    client.setEndpoint('https://ssw.inf.br/ws/sswCotacaoColeta/index.php');

    // chama SEMPRE cotarSite (espelhando o PHP do site)
    const [resultObj, rawXml] = await client.cotarSiteAsync(soapArgs);

    // extrai a string XML
    let xmlString = resultObj?.return?.$value || '';
    if (!xmlString) {
      // fallback: procura qualquer string com <cotacao>...</cotacao>
      const scan = obj => {
        if (!obj || typeof obj !== 'object') return null;
        for (const v of Object.values(obj)) {
          if (typeof v === 'string' && /<cotacao[\s\S]*?<\/cotacao>/i.test(v)) return v;
          if (v && typeof v === 'object') {
            const inner = scan(v);
            if (inner) return inner;
          }
        }
        return null;
      };
      xmlString = scan(resultObj) || '';
    }

    const cotacaoXml = extractCotacaoXml(xmlString);
    if (!cotacaoXml) {
      return res.status(200).json({
        debug: { resultObj, rawSnippet: typeof rawXml === 'string' ? rawXml.slice(0, 1000) : rawXml }
      });
    }

    const erro = int(getTag(cotacaoXml, 'erro'));
    const mensagem = toStr(getTag(cotacaoXml, 'mensagem'));
    const fretePt = getTag(cotacaoXml, 'frete');
    const prazo = int(getTag(cotacaoXml, 'prazo'));
    const cotacaoNum = toStr(getTag(cotacaoXml, 'cotacao'));
    const token = toStr(getTag(cotacaoXml, 'token'));
    const valorFrete = decFromPt(fretePt);

    if (Number.isFinite(erro) && erro !== 0) {
      const code = (erro === -2 || /LOGIN/i.test(mensagem)) ? 401 : 422;
      return res.status(code).json({
        error: 'SSW retornou erro',
        ssw: { erro, mensagem },
        detalhes: { cotacaoXml }
      });
    }

    return res.status(200).json({
      ok: true,
      valorFrete,
      prazoEntrega: prazo,
      numeroCotacao: cotacaoNum,
      token,
      mensagem,
      xml: cotacaoXml
    });
  } catch (err) {
    const status = err.status || 500;
    console.error('[cotacao][erro]', { status, message: err.message });
    return res.status(status).json({
      error: status === 400 ? 'Entrada inválida' : 'Erro ao consultar cotação na SSW',
      details: err.message
    });
  }
}
