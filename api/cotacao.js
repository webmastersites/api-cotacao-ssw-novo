// api/cotacao.js
import { parseStringPromise } from 'xml2js';

// -------- helpers ----------
const digitsOnly = (v) => (v ?? '').toString().replace(/\D+/g, '');
const toFloat = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? undefined : n;
};
const fix3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : '0.000');
const fix4 = (n) => (Number.isFinite(n) ? n.toFixed(4) : '0.0000');
const fix2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '0.00');

const decodeXmlEntities = (s = '') =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

const toNumberPtBr = (v) => {
  if (v == null) return 0;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// ------------- handler ---------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const b = req.body && typeof req.body === 'object'
      ? req.body
      : JSON.parse(req.body || '{}');

    // Campos esperados
    const {
      dominio = 'OST',
      login = 'cotawa',
      senha = '123456',
      cnpjPagador,
      senhaPagador = '1234',

      cepOrigem,
      cepDestino,

      // aceitamos valorMercadoria (preferido) ou valorNF por compat
      valorMercadoria: _valorMercadoria,
      valorNF: _valorNF,

      quantidade,
      peso: _peso,
      volume: _volume,

      mercadoria = 1,
      ciffob: _ciffob,

      cnpjRemetente = '',
      cnpjDestinatario = '',

      observacao = '',

      altura: _altura,
      largura: _largura,
      comprimento: _comprimento,

      // extras opcionais
      coletar: _coletar,
      trt = '',
      entDificil = '',
      destContribuinte = '',
      qtdePares = '',
      fatorMultiplicador = '',
    } = b || {};

    // Normalizações
    const ciffob = (String(_ciffob || '').trim().toUpperCase() || 'F').startsWith('C') ? 'C' : 'F';
    const valorMercadoria = toFloat(_valorMercadoria ?? _valorNF);
    const peso = toFloat(_peso);
    const volume = toFloat(_volume);
    const altura = toFloat(_altura);
    const largura = toFloat(_largura);
    const comprimento = toFloat(_comprimento);
    const qtd = Number.isFinite(Number(quantidade)) ? parseInt(quantidade, 10) : 1;

    const sentArgs = {
      dominio: String(dominio).toUpperCase(),
      login,
      senha,
      cnpjPagador: digitsOnly(cnpjPagador),
      senhaPagador,

      cepOrigem: digitsOnly(cepOrigem),
      cepDestino: digitsOnly(cepDestino),

      valorNF: fix2(valorMercadoria ?? 0),

      quantidade: qtd,
      peso: fix3(peso ?? 0),
      volume: fix4(volume ?? 0),

      mercadoria: Number(mercadoria) || 1,
      ciffob,

      cnpjRemetente: digitsOnly(cnpjRemetente),
      cnpjDestinatario: digitsOnly(cnpjDestinatario),

      observacao: String(observacao || ''),

      trt: String(trt || ''),
      coletar: String((_coletar || 'N')).toUpperCase() === 'S' ? 'S' : 'N',
      entDificil: String(entDificil || ''),
      destContribuinte: String(destContribuinte || ''),
      qtdePares: String(qtdePares || ''),

      altura: fix3(altura ?? 0),
      largura: fix3(largura ?? 0),
      comprimento: fix3(comprimento ?? 0),

      fatorMultiplicador: String(fatorMultiplicador || ''),
    };

    // -------- validação mínima --------
    const errs = [];
    if (!sentArgs.cnpjPagador) errs.push('cnpjPagador é obrigatório');
    if (!sentArgs.cepOrigem) errs.push('cepOrigem é obrigatório');
    if (!sentArgs.cepDestino) errs.push('cepDestino é obrigatório');

    const vm = toFloat(valorMercadoria);
    if (!(Number.isFinite(vm) && vm > 0)) errs.push('valorMercadoria deve ser > 0');

    const pesoNum = toFloat(_peso) || 0;
    const volNum = toFloat(_volume) || 0;
    if (!(pesoNum > 0 || volNum > 0)) errs.push('informe peso (>0) ou volume (>0)');

    if (errs.length) {
      return res.status(400).json({
        error: 'Entrada inválida',
        details: errs.join('; '),
      });
    }

    // -------- SOAP envelope ----------
    const soapRequestXml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"  xmlns:tns="urn:sswinfbr.sswCotacaoColeta">
  <soap:Body>
    <tns:cotarSite>
      <dominio>${sentArgs.dominio}</dominio>
      <login>${sentArgs.login}</login>
      <senha>${sentArgs.senha}</senha>
      <cnpjPagador>${sentArgs.cnpjPagador}</cnpjPagador>
      <senhaPagador>${sentArgs.senhaPagador}</senhaPagador>
      <cepOrigem>${sentArgs.cepOrigem}</cepOrigem>
      <cepDestino>${sentArgs.cepDestino}</cepDestino>
      <valorNF>${sentArgs.valorNF}</valorNF>
      <quantidade>${sentArgs.quantidade}</quantidade>
      <peso>${sentArgs.peso}</peso>
      <volume>${sentArgs.volume}</volume>
      <mercadoria>${sentArgs.mercadoria}</mercadoria>
      <ciffob>${sentArgs.ciffob}</ciffob>
      <cnpjRemetente>${sentArgs.cnpjRemetente}</cnpjRemetente>
      <cnpjDestinatario>${sentArgs.cnpjDestinatario}</cnpjDestinatario>
      <observacao>${escapeXml(sentArgs.observacao)}</observacao>
      <trt>${sentArgs.trt}</trt>
      <coletar>${sentArgs.coletar}</coletar>
      <entDificil>${sentArgs.entDificil}</entDificil>
      <destContribuinte>${sentArgs.destContribuinte}</destContribuinte>
      <qtdePares>${sentArgs.qtdePares}</qtdePares>
      <altura>${sentArgs.altura}</altura>
      <largura>${sentArgs.largura}</largura>
      <comprimento>${sentArgs.comprimento}</comprimento>
      <fatorMultiplicador>${sentArgs.fatorMultiplicador}</fatorMultiplicador>
    </tns:cotarSite>
  </soap:Body>
</soap:Envelope>`;

    // -------- chama SSW -----------
    const fetchRes = await fetch('https://ssw.inf.br/ws/sswCotacaoColeta/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'urn:sswinfbr.sswCotacaoColeta#cotarSite',
      },
      body: soapRequestXml,
    });

    const soapText = await fetchRes.text();

    // -------- parse SOAP externo -----
    let inner = '';
    try {
      const soapObj = await parseStringPromise(soapText, { explicitArray: true, trim: true });
      // tentativa padrão
      inner =
        soapObj?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body']?.[0]?.['ns1:cotarSiteResponse']?.[0]?.return?.[0] ??
        soapObj?.['soap:Envelope']?.['soap:Body']?.[0]?.['tns:cotarSiteResponse']?.[0]?.return?.[0] ??
        '';
    } catch {
      // fallback por regex
      const m = soapText.match(/<return[^>]*>([\s\S]*?)<\/return>/i);
      inner = m ? m[1] : '';
    }

    const innerXml = decodeXmlEntities(inner || '').trim();
    if (!innerXml) {
      return res.status(502).json({
        error: 'Erro ao consultar cotação na SSW',
        details: 'Resposta inesperada',
        sentArgs,
        lastRequest: soapRequestXml,
        rawSoap: soapText,
      });
    }

    // -------- parse XML interno (cotacao) -----
    const innerObj = await parseStringPromise(innerXml, { explicitArray: true, trim: true });
    const c = innerObj?.cotacao || {};
    const erro = (c.erro?.[0] ?? '').toString();
    const mensagem = c.mensagem?.[0] || '';
    const fretePtBr = c.frete?.[0] || '0,00';
    const prazo = c.prazo?.[0] || '0';
    const numeroCotacao = c.cotacao?.[0] || '';
    const token = c.token?.[0] || '';

    if (erro === '0') {
      return res.status(200).json({
        ok: true,
        valorFrete: +toNumberPtBr(fretePtBr).toFixed(2),
        prazoEntrega: parseInt(prazo, 10) || 0,
        numeroCotacao,
        token,
        mensagem,
        lastRequest: soapRequestXml, // útil pra debug
      });
    }

    // SSW retornou erro (negócio)
    return res.status(422).json({
      error: 'SSW retornou erro',
      ssw: { erro: 1, mensagem },
      detalhes: { cotacaoXml: innerXml },
      sentArgs,
      lastRequest: soapRequestXml,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'FUNCTION_INVOCATION_FAILED',
      message: err?.message || String(err),
    });
  }
}

// escapador simples p/ observacao
function escapeXml(unsafe = '') {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
