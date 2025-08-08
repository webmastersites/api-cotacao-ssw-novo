// api/cotacao.js
// Vercel/Next API Route

const axios = require('axios');
const { parseStringPromise } = require('xml2js');

// ============ utils ============
const onlyDigits = (v) => (v ?? '').toString().replace(/\D+/g, '');
const toFixedOrZero = (n, d = 2) => {
  const x = parseFloat(String(n).replace(',', '.'));
  return isNaN(x) ? (0).toFixed(d) : x.toFixed(d);
};
const toUpper = (v) => (v ?? '').toString().trim().toUpperCase();
const padCpfToCnpj = (doc) => {
  const d = onlyDigits(doc);
  if (!d) return '';
  return d.length === 11 ? d.padStart(14, '0') : d;
};
const parseFrete = (s) => {
  if (!s) return 0;
  // SSW retorna com vírgula decimal. Ex.: "159,77"
  const n = parseFloat(String(s).replace('.', '').replace(',', '.'));
  return isNaN(n) ? 0 : +n.toFixed(2);
};

// ============ validação básica ============
function validateBody(body) {
  const err = [];

  const cnpjPagador = padCpfToCnpj(body.cnpjPagador);
  if (!cnpjPagador) err.push('cnpjPagador é obrigatório');

  const cepOrigem = onlyDigits(body.cepOrigem);
  if (!cepOrigem) err.push('cepOrigem é obrigatório');

  const cepDestino = onlyDigits(body.cepDestino);
  if (!cepDestino) err.push('cepDestino é obrigatório');

  // valor pode vir como valorMercadoria OU valorNF
  const valorMercadoriaRaw = body.valorMercadoria ?? body.valorNF;
  const valorMercadoria = parseFloat(String(valorMercadoriaRaw ?? '').replace(',', '.'));
  if (isNaN(valorMercadoria) || valorMercadoria <= 0) {
    err.push('valorMercadoria deve ser > 0');
  }

  const peso = parseFloat(String(body.peso ?? '').replace(',', '.'));
  const volume = parseFloat(String(body.volume ?? '').replace(',', '.'));
  if (!(peso > 0) && !(volume > 0)) {
    err.push('informe peso (>0) ou volume (>0)');
  }

  return { ok: err.length === 0, errors: err };
}

// ============ monta envelope SOAP ============
function buildSoapEnvelope(args) {
  // Todos os campos tratados/normalizados já devem vir em args
  const {
    dominio,
    login,
    senha,
    cnpjPagador,
    senhaPagador,
    cepOrigem,
    cepDestino,
    valorNF, // string com 2 casas
    quantidade,
    peso,     // string com 3 casas
    volume,   // string com 4 casas
    mercadoria,
    ciffob,   // 'C' ou 'F'
    cnpjRemetente,
    cnpjDestinatario,
    observacao,
    trt,
    coletar, // 'S' ou 'N'
    entDificil,
    destContribuinte,
    qtdePares,
    altura,  // 3 casas
    largura, // 3 casas
    comprimento, // 3 casas
    fatorMultiplicador
  } = args;

  // Atenção: cotarSite segundo o WSDL
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"  xmlns:tns="urn:sswinfbr.sswCotacaoColeta">
  <soap:Body>
    <tns:cotarSite>
      <dominio>${dominio}</dominio>
      <login>${login}</login>
      <senha>${senha}</senha>
      <cnpjPagador>${cnpjPagador}</cnpjPagador>
      <senhaPagador>${senhaPagador}</senhaPagador>
      <cepOrigem>${cepOrigem}</cepOrigem>
      <cepDestino>${cepDestino}</cepDestino>
      <valorNF>${valorNF}</valorNF>
      <quantidade>${quantidade}</quantidade>
      <peso>${peso}</peso>
      <volume>${volume}</volume>
      <mercadoria>${mercadoria}</mercadoria>
      <ciffob>${ciffob}</ciffob>
      <cnpjRemetente>${cnpjRemetente}</cnpjRemetente>
      <cnpjDestinatario>${cnpjDestinatario}</cnpjDestinatario>
      <observacao>${observacao}</observacao>
      <trt>${trt}</trt>
      <coletar>${coletar}</coletar>
      <entDificil>${entDificil}</entDificil>
      <destContribuinte>${destContribuinte}</destContribuinte>
      <qtdePares>${qtdePares}</qtdePares>
      <altura>${altura}</altura>
      <largura>${largura}</largura>
      <comprimento>${comprimento}</comprimento>
      <fatorMultiplicador>${fatorMultiplicador}</fatorMultiplicador>
    </tns:cotarSite>
  </soap:Body>
</soap:Envelope>`;
}

// ============ handler ============
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    // CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    // ---- validação amigável ----
    const v = validateBody(body);
    if (!v.ok) {
      return res.status(400).json({
        error: 'Entrada inválida',
        details: v.errors.join('; ')
      });
    }

    // ---- normalizações/valores padrão ----
    const dominio = (body.dominio || 'OST').toString().toUpperCase();
    const login = body.login || 'cotawa';
    const senha = body.senha || '123456';

    const cnpjPagador = padCpfToCnpj(body.cnpjPagador);
    const senhaPagador = body.senhaPagador || '1234';

    const cepOrigem = onlyDigits(body.cepOrigem);
    const cepDestino = onlyDigits(body.cepDestino);

    const valorMercadoriaRaw = body.valorMercadoria ?? body.valorNF;
    const valorNF = toFixedOrZero(valorMercadoriaRaw, 2);

    const quantidade = parseInt(body.quantidade ?? '1', 10) || 1;

    const pesoStr = toFixedOrZero(body.peso, 3);     // "23.000"
    const volumeStr = toFixedOrZero(body.volume, 4); // "0.2700"

    const mercadoria = parseInt(body.mercadoria ?? 1, 10) || 1;

    const tipo = toUpper(body.ciffob);
    const ciffob = (tipo === 'C' || tipo === 'CIF') ? 'C' : 'F';

    // documentos — aceita CPF (11d) e faz zeropad p/14
    const cnpjRemetente = padCpfToCnpj(body.cnpjRemetente || '');
    const cnpjDestinatario = padCpfToCnpj(body.cnpjDestinatario || '');

    const observacao = (body.observacao || '').toString();

    const altura = toFixedOrZero(body.altura, 3);
    const largura = toFixedOrZero(body.largura, 3);
    const comprimento = toFixedOrZero(body.comprimento, 3);

    // Extras: agora padrão é 'S' (coleta). Se vier definido, respeita.
    const coletar = toUpper(body.coletar || 'S'); // <= mudança pedida
    const trt = body.trt ?? '';
    const entDificil = body.entDificil ?? '';
    const destContribuinte = body.destContribuinte ?? '';
    const qtdePares = body.qtdePares ?? '';
    const fatorMultiplicador = body.fatorMultiplicador ?? '';

    const args = {
      dominio,
      login,
      senha,
      cnpjPagador,
      senhaPagador,
      cepOrigem,
      cepDestino,
      valorNF,
      quantidade,
      peso: pesoStr,
      volume: volumeStr,
      mercadoria,
      ciffob,
      cnpjRemetente,
      cnpjDestinatario,
      observacao,
      trt,
      coletar,
      entDificil,
      destContribuinte,
      qtdePares,
      altura,
      largura,
      comprimento,
      fatorMultiplicador
    };

    const soapEnvelope = buildSoapEnvelope(args);

    // ---- chamada ao SSW ----
    const { data: responseXml } = await axios.post(
      'https://ssw.inf.br/ws/sswCotacaoColeta/index.php',
      soapEnvelope,
      {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'urn:sswinfbr.sswCotacaoColeta#cotarSite'
        },
        timeout: 30000
      }
    );

    // A resposta costuma vir com o XML de <cotacao> (sem o envelope SOAP)
    // Vamos tentar extrair os campos via xml2js de forma tolerante.
    let cotacaoXml = responseXml;
    // Em alguns casos, a API retorna diretamente o XML <cotacao> como string literal.
    // Em outros, pode vir um SOAP completo. Vamos procurar o primeiro "<cotacao".
    const idx = responseXml.indexOf('<cotacao');
    if (idx > -1) {
      cotacaoXml = responseXml.slice(idx);
      // corta depois do fechamento
      const endIdx = cotacaoXml.indexOf('</cotacao>');
      if (endIdx > -1) cotacaoXml = cotacaoXml.slice(0, endIdx + '</cotacao>'.length);
    }

    // Faz o parse do pedacinho de <cotacao>
    const parsed = await parseStringPromise(cotacaoXml, { explicitArray: false, trim: true })
      .catch(() => ({}));

    const c = parsed?.cotacao || parsed || {};

    const erro = parseInt((c.erro ?? '1'), 10) || 0;
    const mensagem = c.mensagem ?? '';
    const frete = parseFrete(c.frete);
    const prazo = parseInt(c.prazo ?? '0', 10) || 0;
    const numeroCotacao = c.cotacao ?? '';
    const token = c.token ?? '';

    if (erro && erro !== 0) {
      // erro do SSW
      return res.status(422).json({
        error: 'SSW retornou erro',
        ssw: { erro, mensagem },
        detalhes: { cotacaoXml },
        sentArgs: args,
        lastRequest: soapEnvelope
      });
    }

    // sucesso
    return res.status(200).json({
      ok: true,
      valorFrete: frete,
      prazoEntrega: prazo,
      numeroCotacao,
      token,
      mensagem: mensagem || 'OK',
      lastRequest: soapEnvelope
    });

  } catch (err) {
    const details = (err && err.response && err.response.data) ? err.response.data : (err?.message || String(err));
    return res.status(500).json({
      error: 'Erro ao consultar cotação na SSW',
      details
    });
  }
};
