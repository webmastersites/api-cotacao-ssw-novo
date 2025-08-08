import { createClientAsync } from 'soap';

// ---------- helpers ----------
const toStr = v => (v ?? '').toString().trim();
const onlyDigits = s => toStr(s).replace(/\D/g, '');

// "1.500,00"->"1500.00", "1500.00"->"1500.00", "0,27"->"0.27", "0.27"->"0.27"
const normDecimalStr = (val) => {
  if (val === undefined || val === null || val === '') return null;
  const s = toStr(val);
  if (s.includes(',')) return s.replace(/\./g, '').replace(',', '.');
  return s;
};
const toDec = v => {
  const s = normDecimalStr(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const toInt = v => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(onlyDigits(v), 10);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n, places) => {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(places) : '';
};

const extractCotacaoXml = (text) => {
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
const decFromPt = (s) => {
  if (!s) return null;
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // credenciais fixas
    const dominio = 'OST';
    const login = 'cotawa';
    const senha = '123456';
    const senhaPagador = '1234';

    // sanitização
    const cnpjPagador = onlyDigits(b.cnpjPagador);
    const cnpjRemetente = onlyDigits(b.remetente?.cnpj);
    const cnpjDestinatario = onlyDigits(b.destinatario?.cnpj);
    const cepOrigem = onlyDigits(b.cepOrigem);
    const cepDestino = onlyDigits(b.cepDestino);

    const valorNFnum = toDec(b.valorMercadoria);
    const quantidade = toInt(b.quantidadeVolumes) ?? 1;
    const pesoNum = toDec(b.peso);
    const volumeNum = toDec(b.volume);

    const alturaNum = toDec(b.altura);
    const larguraNum = toDec(b.largura);
    const comprimentoNum = toDec(b.comprimento);

    const ciffob = toStr(b.ciffob).toUpperCase().replace(/[^CF]/g, '').charAt(0) || 'F';
    const observacao = toStr(b.observacao).slice(0, 195);
    const mercadoria = '1';

    // coletar obrigatório: "S" ou "N"
    const coletar = toStr(b.coletar).toUpperCase().startsWith('S') ? 'S' : 'N';

    // extras do WSDL (vamos enviar vazios)
    const trt = '';
    const entDificil = '';
    const destContribuinte = '';
    const qtdePares = '';          // integer opcional – vazio
    const fatorMultiplicador = ''; // integer opcional – vazio

    // validações básicas
    const errs = [];
    if (!cnpjPagador) errs.push('cnpjPagador é obrigatório');
    if (!cepOrigem) errs.push('cepOrigem é obrigatório');
    if (!cepDestino) errs.push('cepDestino é obrigatório');
    if (!(valorNFnum > 0)) errs.push('valorMercadoria deve ser > 0');
    if (!['C', 'F'].includes(ciffob)) errs.push('ciffob deve ser C ou F');
    if (!((pesoNum ?? 0) > 0) && !((volumeNum ?? 0) > 0)) errs.push('informe peso (>0) ou volume (>0)');
    if (errs.length) {
      return res.status(400).json({ error: 'Entrada inválida', details: errs.join('; ') });
    }

    // MONTAÇÃO EM ORDEM EXATA DO WSDL (rpc/encoded é chato com ordem):
    const orderedEntries = [
      ['dominio', dominio],
      ['login', login],
      ['senha', senha],
      ['cnpjPagador', cnpjPagador],
      ['senhaPagador', senhaPagador],
      ['cepOrigem', cepOrigem],
      ['cepDestino', cepDestino],
      ['valorNF', fmt(valorNFnum, 2)],                 // 1500.00
      ['quantidade', String(quantidade)],              // "1"
      ['peso', fmt(pesoNum, 3)],                       // 23.000
      ['volume', volumeNum != null ? fmt(volumeNum, 4) : ''], // 0.2700
      ['mercadoria', mercadoria],
      ['ciffob', ciffob],
      ['cnpjRemetente', cnpjRemetente || ''],
      ['cnpjDestinatario', cnpjDestinatario || ''],
      ['observacao', observacao],
      ['trt', trt],
      ['coletar', coletar],              // <<< AQUI, na posição certa
      ['entDificil', entDificil],
      ['destContribuinte', destContribuinte],
      ['qtdePares', qtdePares],
      ['altura', alturaNum != null ? fmt(alturaNum, 3) : ''],
      ['largura', larguraNum != null ? fmt(larguraNum, 3) : ''],
      ['comprimento', comprimentoNum != null ? fmt(comprimentoNum, 3) : ''],
      ['fatorMultiplicador', fatorMultiplicador]
    ];
    const soapArgs = orderedEntries.reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

    const soapUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';
    const client = await createClientAsync(soapUrl);
    client.setEndpoint('https://ssw.inf.br/ws/sswCotacaoColeta/index.php');

    const [result, rawResponse, soapHeader, rawRequest] = await client.cotarSiteAsync(soapArgs);
    const lastRequest = client.lastRequest || rawRequest || null;

    // tenta obter XML de retorno
    let xmlCandidate = null;
    if (result && typeof result === 'object') {
      const r = result.return;
      if (r && typeof r === 'object' && typeof r.$value === 'string') xmlCandidate = r.$value;
      else if (typeof r === 'string') xmlCandidate = r;
    }
    if (!xmlCandidate && typeof rawResponse === 'string') {
      const m = String(rawResponse).match(/<cotacao[\s\S]*?<\/cotacao>/i);
      if (m) xmlCandidate = m[0];
    }
    if (!xmlCandidate) {
      return res.status(200).json({
        debug: true,
        message: 'Sem bloco <cotacao> detectado na resposta',
        sentArgs: soapArgs,
        rawResponseSnippet: typeof rawResponse === 'string' ? rawResponse.slice(0, 1500) : null,
        lastRequest
      });
    }

    const cotacaoXml = xmlCandidate;
    const erro = parseInt(getTag(cotacaoXml, 'erro') || '0', 10);
    const mensagem = getTag(cotacaoXml, 'mensagem') || '';
    const fretePt = getTag(cotacaoXml, 'frete');
    const prazo = parseInt(getTag(cotacaoXml, 'prazo') || '0', 10);
    const cotacaoNum = getTag(cotacaoXml, 'cotacao') || '';
    const token = getTag(cotacaoXml, 'token') || '';
    const valorFrete = decFromPt(fretePt);

    if (Number.isFinite(erro) && erro !== 0) {
      return res.status(422).json({
        error: 'SSW retornou erro',
        ssw: { erro, mensagem },
        detalhes: { cotacaoXml },
        sentArgs: soapArgs,
        lastRequest
      });
    }

    return res.status(200).json({
      ok: true,
      valorFrete,
      prazoEntrega: prazo,
      numeroCotacao: cotacaoNum,
      token,
      mensagem,
      lastRequest
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Erro ao consultar cotação na SSW',
      details: err.message
    });
  }
}
