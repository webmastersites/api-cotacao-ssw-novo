import { createClientAsync } from 'soap';

// ---------- helpers ----------
const toStr = v => (v ?? '').toString().trim();
const onlyDigits = s => toStr(s).replace(/\D/g, '');
const toDec = v => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(toStr(v).replace(/\./g, '').replace(',', '.'));
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

    // credenciais fixas (como você pediu)
    const dominio = 'OST';
    const login = 'cotawa';
    const senha = '123456';
    const senhaPagador = '1234';

    // sanitização de entrada
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

    // validações essenciais
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

    // formatos exigidos pela doc (ponto, casas definidas)
    const soapArgs = {
      dominio, login, senha,
      cnpjPagador, senhaPagador,
      cepOrigem, cepDestino,
      valorNF: fmt(valorNFnum, 2),            // "1500.00"
      quantidade: String(quantidade),         // "1"
      peso: fmt(pesoNum, 3),                  // "23.000"
      volume: volumeNum != null ? fmt(volumeNum, 4) : "", // "0.2700" ou ""
      mercadoria, ciffob,
      cnpjRemetente: cnpjRemetente || "",
      cnpjDestinatario: cnpjDestinatario || "",
      observacao,
      altura: alturaNum != null ? fmt(alturaNum, 3) : "",
      largura: larguraNum != null ? fmt(larguraNum, 3) : "",
      comprimento: comprimentoNum != null ? fmt(comprimentoNum, 3) : ""
    };

    const soapUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';
    const client = await createClientAsync(soapUrl);
    client.setEndpoint('https://ssw.inf.br/ws/sswCotacaoColeta/index.php');

    // chame e capture TUDO (result + rawResponse + rawRequest)
    const [result, rawResponse, soapHeader, rawRequest] = await client.cotarSiteAsync(soapArgs);
    const lastRequest = client.lastRequest || rawRequest || null;

    // tente obter XML de retorno por etapas
    let xmlCandidate = null;

    // 1) retorno comum do node-soap
    if (result && typeof result === 'object') {
      const r = result.return;
      if (r && typeof r === 'object' && typeof r.$value === 'string') xmlCandidate = r.$value;
      else if (typeof r === 'string') xmlCandidate = r;
    }
    // 2) se não, use o rawResponse (SOAP envelope)
    if (!xmlCandidate && typeof rawResponse === 'string') {
      // se vier um envelope SOAP, extraímos só o <cotacao> dele
      const extracted = extractCotacaoXml(rawResponse);
      if (extracted) xmlCandidate = extracted;
    }

    // 3) se ainda não temos xmlCandidate, devolvemos debug completo
    if (!xmlCandidate) {
      return res.status(200).json({
        debug: true,
        message: 'Sem bloco <cotacao> detectado na resposta',
        sentArgs: soapArgs,
        types: {
          resultType: typeof result,
          resultReturnType: typeof result?.return,
          rawResponseType: typeof rawResponse
        },
        rawResponseSnippet: typeof rawResponse === 'string' ? rawResponse.slice(0, 1500) : null,
        lastRequest
      });
    }

    // Se xmlCandidate for apenas o bloco <cotacao>, beleza. Se for string grande, ainda tentamos refinar:
    const cotacaoXml = extractCotacaoXml(xmlCandidate) || xmlCandidate;

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
