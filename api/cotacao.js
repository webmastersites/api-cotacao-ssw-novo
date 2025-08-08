// /api/cotacao.js
// Handler Vercel/Next para cotar frete via SSW (cotarSite)
// Robustez: normaliza tipos, evita .replace em não-strings, e retorna debug útil.

import { parseStringPromise } from 'xml2js';

// ---------- helpers ----------
const toSafeString = (v) => (v === undefined || v === null ? '' : String(v));
const onlyDigits = (v) => toSafeString(v).replace(/\D+/g, '');

// 11 dígitos (CPF) -> left pad até 14 (CNPJ); se 14 mantém; senão devolve só dígitos
const zeroPadCpfCnpj = (doc) => {
  const d = onlyDigits(doc);
  if (!d) return '';
  if (d.length === 11) return d.padStart(14, '0');
  return d;
};

// parse decimal qualquer (aceita ","), devolve Number (ou 0 se inválido)
const toNumber = (v) => {
  const n = parseFloat(toSafeString(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

// formata decimal com casas fixas, devolvendo string com ponto
const fmtDec = (v, decimals) => toNumber(v).toFixed(decimals);

// "CIF"|"FOB" (variações) -> "C"|"F"
const normalizeCifFob = (v) => {
  const t = toSafeString(v).trim().toLowerCase();
  return (t === 'c' || t === 'cif') ? 'C' : 'F';
};

// S/N (default "S")
const normalizeColetar = (v) => {
  const t = toSafeString(v).trim().toUpperCase();
  return t === 'N' ? 'N' : 'S';
};

// monta o envelope SOAP RPC
const buildSoap = (args) => {
  const esc = (s) => toSafeString(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"  xmlns:tns="urn:sswinfbr.sswCotacaoColeta">
  <soap:Body>
    <tns:cotarSite>
      <dominio>${esc(args.dominio)}</dominio>
      <login>${esc(args.login)}</login>
      <senha>${esc(args.senha)}</senha>
      <cnpjPagador>${esc(args.cnpjPagador)}</cnpjPagador>
      <senhaPagador>${esc(args.senhaPagador)}</senhaPagador>
      <cepOrigem>${esc(args.cepOrigem)}</cepOrigem>
      <cepDestino>${esc(args.cepDestino)}</cepDestino>
      <valorNF>${esc(args.valorNF)}</valorNF>
      <quantidade>${esc(args.quantidade)}</quantidade>
      <peso>${esc(args.peso)}</peso>
      <volume>${esc(args.volume)}</volume>
      <mercadoria>${esc(args.mercadoria)}</mercadoria>
      <ciffob>${esc(args.ciffob)}</ciffob>
      <cnpjRemetente>${esc(args.cnpjRemetente)}</cnpjRemetente>
      <cnpjDestinatario>${esc(args.cnpjDestinatario)}</cnpjDestinatario>
      <observacao>${esc(args.observacao)}</observacao>
      <trt>${esc(args.trt)}</trt>
      <coletar>${esc(args.coletar)}</coletar>
      <entDificil>${esc(args.entDificil)}</entDificil>
      <destContribuinte>${esc(args.destContribuinte)}</destContribuinte>
      <qtdePares>${esc(args.qtdePares)}</qtdePares>
      <altura>${esc(args.altura)}</altura>
      <largura>${esc(args.largura)}</largura>
      <comprimento>${esc(args.comprimento)}</comprimento>
      <fatorMultiplicador>${esc(args.fatorMultiplicador)}</fatorMultiplicador>
    </tns:cotarSite>
  </soap:Body>
</soap:Envelope>`;
};

// extrai XML de retorno interno do SOAP (string dentro de <return>)
const extractInnerXml = async (soapXml) => {
  const parsed = await parseStringPromise(soapXml, { explicitArray: true, ignoreAttrs: false });
  // procurar "return" independente de prefixo
  const body =
    parsed?.['SOAP-ENV:Envelope']?.['SOAP-ENV:Body'] ||
    parsed?.['soap:Envelope']?.['soap:Body'] ||
    parsed?.Envelope?.Body;

  if (!body) return null;

  let retNode;
  // diferentes namespaces possíveis
  for (const k of Object.keys(body)) {
    const maybe = body[k]?.[0];
    if (maybe && typeof maybe === 'object' && 'return' in maybe) {
      retNode = maybe.return?.[0];
      break;
    }
  }

  if (!retNode) return null;
  return toSafeString(retNode); // é uma string XML (cotacao/coleta)
};

// parse do XML de cotação interna (ex.: <cotacao>...</cotacao>)
const parseCotacaoXml = async (xmlStr) => {
  const inner = await parseStringPromise(xmlStr, { explicitArray: false });
  // pode ser <cotacao> ou <coleta> dependendo do endpoint
  const root = inner?.cotacao || inner?.coleta || inner;

  const erro = toSafeString(root?.erro);
  const mensagem = toSafeString(root?.mensagem);

  const freteRaw = toSafeString(root?.frete).replace('.', '').replace(',', '.'); // "159,77" -> "159.77"
  const valorFrete = toNumber(freteRaw);

  const prazoEntrega = parseInt(toSafeString(root?.prazo), 10) || null;
  const numeroCotacao = toSafeString(root?.cotacao);
  const token = toSafeString(root?.token);

  return { erro, mensagem, valorFrete, prazoEntrega, numeroCotacao, token };
};

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const b = req.body || {};

    // -------- normalização de entrada --------
    const dominio = toSafeString(b.dominio || 'OST').toUpperCase();
    const login = toSafeString(b.login || 'cotawa');
    const senha = toSafeString(b.senha || '123456');

    const cnpjPagador = zeroPadCpfCnpj(b.cnpjPagador);
    const senhaPagador = toSafeString(b.senhaPagador || '1234');

    const cepOrigem = onlyDigits(b.cepOrigem);
    const cepDestino = onlyDigits(b.cepDestino);

    // nome de entrada: valorMercadoria (API nossa) -> valorNF (SSW)
    const valorMercadoria = b.valorMercadoria ?? b.valorNF ?? '0';
    const valorNF = fmtDec(valorMercadoria, 2);

    const quantidade = Math.max(parseInt(toSafeString(b.quantidade), 10) || 1, 1);

    const peso = fmtDec(b.peso ?? 0, 3);
    const volume = fmtDec(b.volume ?? 0, 4);

    const mercadoria = parseInt(toSafeString(b.mercadoria || 1), 10) || 1;
    const ciffob = normalizeCifFob(b.ciffob);

    // documentos (enviar mesmo vazios — mas com zeroPad se vierem)
    const cnpjRemetente = zeroPadCpfCnpj(b.cnpjRemetente);
    const cnpjDestinatario = zeroPadCpfCnpj(b.cnpjDestinatario);

    const observacao = toSafeString(b.observacao);

    const altura = fmtDec(b.altura ?? 0, 3);
    const largura = fmtDec(b.largura ?? 0, 3);
    const comprimento = fmtDec(b.comprimento ?? 0, 3);

    // extras opcionais (enviar sempre)
    const coletar = normalizeColetar(b.coletar); // default "S"
    const trt = toSafeString(b.trt);
    const entDificil = toSafeString(b.entDificil);
    const destContribuinte = toSafeString(b.destContribuinte);
    const qtdePares = toSafeString(b.qtdePares);
    const fatorMultiplicador = toSafeString(b.fatorMultiplicador);

    // validação mínima
    const errs = [];
    if (!cnpjPagador) errs.push('cnpjPagador é obrigatório');
    if (!cepOrigem) errs.push('cepOrigem é obrigatório');
    if (!cepDestino) errs.push('cepDestino é obrigatório');
    if (toNumber(valorNF) <= 0) errs.push('valorMercadoria deve ser > 0');
    if (toNumber(peso) <= 0 && toNumber(volume) <= 0)
      errs.push('informe peso (>0) ou volume (>0)');

    if (errs.length) {
      res.status(400).json({ error: 'Entrada inválida', details: errs.join('; ') });
      return;
    }

    // montar args -> SOAP
    const args = {
      dominio,
      login,
      senha,
      cnpjPagador,
      senhaPagador,
      cepOrigem,
      cepDestino,
      valorNF,                // <- enviado como valorNF
      quantidade,
      peso,
      volume,
      mercadoria,
      ciffob,
      cnpjRemetente,          // <- agora sempre enviados
      cnpjDestinatario,       // <-
      observacao,
      trt,
      coletar,                // <- default "S"
      entDificil,
      destContribuinte,
      qtdePares,
      altura,
      largura,
      comprimento,
      fatorMultiplicador
    };

    const soapBody = buildSoap(args);

    // chamada SOAP
    const resp = await fetch('https://ssw.inf.br/ws/sswCotacaoColeta/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'urn:sswinfbr.sswCotacaoColeta#cotarSite'
      },
      body: soapBody,
    });

    const respText = await resp.text();

    // extrair xml interno do <return>
    const innerXml = await extractInnerXml(respText);
    if (!innerXml) {
      return res.status(502).json({
        error: 'Erro ao consultar cotação na SSW',
        details: 'Resposta SOAP sem nó <return>',
        sentArgs: args,
        lastRequest: soapBody
      });
    }

    // parse do xml interno
    const parsed = await parseCotacaoXml(innerXml);

    if (parsed.erro && parsed.erro !== '0') {
      return res.status(422).json({
        error: 'SSW retornou erro',
        ssw: { erro: toSafeString(parsed.erro), mensagem: parsed.mensagem },
        detalhes: { cotacaoXml: innerXml },
        sentArgs: args,
        lastRequest: soapBody
      });
    }

    // sucesso
    return res.status(200).json({
      ok: true,
      valorFrete: parsed.valorFrete,     // Number
      prazoEntrega: parsed.prazoEntrega, // Number|null
      numeroCotacao: parsed.numeroCotacao,
      token: parsed.token,
      mensagem: parsed.mensagem || 'OK',
      lastRequest: soapBody
    });

  } catch (err) {
    return res.status(500).json({
      error: 'Erro interno',
      message: toSafeString(err?.message || err),
      stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined
    });
  }
}
