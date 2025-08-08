import { createClientAsync } from 'soap';

// ===== Helpers =====
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
const fmtDot = (n, places) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return num.toFixed(places); // ponto
};

// ===== XML utils =====
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

// ===== Handler =====
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // Credenciais fixas
  const dominio = 'OST';
  const login = 'cotawa';
  const senha = '123456';
  const senhaPagador = '1234';

  // Dados do body (sanitizados)
  const cnpjPagador = onlyDigits(raw.cnpjPagador);
  const cnpjRemetente = onlyDigits(raw.remetente?.cnpj);
  const cnpjDestinatario = onlyDigits(raw.destinatario?.cnpj);
  const cepOrigem = onlyDigits(raw.cepOrigem);
  const cepDestino = onlyDigits(raw.cepDestino);

  const valorNFnum = toDec(raw.valorMercadoria);
  const quantidade = toInt(raw.quantidadeVolumes) ?? 1;
  const pesoNum = toDec(raw.peso);
  const volumeNum = toDec(raw.volume);

  const alturaNum = toDec(raw.altura);
  const larguraNum = toDec(raw.largura);
  const comprimentoNum = toDec(raw.comprimento);

  const ciffob = toStr(raw.ciffob).toUpperCase().replace(/[^CF]/g, '').charAt(0) || 'F';
  const observacao = toStr(raw.observacao).slice(0, 195);
  const mercadoria = '1';

  // Validações mínimas
  const errs = [];
  if (!cnpjPagador) errs.push('cnpjPagador é obrigatório');
  if (!cepOrigem) errs.push('cepOrigem é obrigatório');
  if (!cepDestino) errs.push('cepDestino é obrigatório');
  if (!(valorNFnum > 0)) errs.push('valorMercadoria deve ser > 0');
  if (!['C', 'F'].includes(ciffob)) errs.push('ciffob deve ser C ou F');
  if (!((pesoNum ?? 0) > 0) && !((volumeNum ?? 0) > 0)) {
    errs.push('informe peso (>0) ou volume (>0)');
  }
  if (errs.length) {
    return res.status(400).json({ error: 'Entrada inválida', details: errs.join('; ') });
  }

  // Formatos exigidos pela doc
  const soapArgs = {
    dominio,
    login,
    senha,
    cnpjPagador,
    senhaPagador,
    cepOrigem,
    cepDestino,
    valorNF: fmtDot(valorNFnum, 2),              // "1500.00"
    quantidade: String(quantidade),              // "1"
    peso: fmtDot(pesoNum ?? 0, 3),               // "23.000"
    volume: volumeNum != null ? fmtDot(volumeNum, 4) : "", // "0.2700" ou ""
    mercadoria,                                  // "1"
    ciffob,
    cnpjRemetente: cnpjRemetente || "",
    cnpjDestinatario: cnpjDestinatario || "",
    observacao,
    altura: alturaNum != null ? fmtDot(alturaNum, 3) : "",
    largura: larguraNum != null ? fmtDot(larguraNum, 3) : "",
    comprimento: comprimentoNum != null ? fmtDot(comprimentoNum, 3) : ""
  };

  try {
    const soapUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';
    const client = await createClientAsync(soapUrl);
    client.setEndpoint('https://ssw.inf.br/ws/sswCotacaoColeta/index.php');

    // Chama cotarSite
    const [resultObj] = await client.cotarSiteAsync(soapArgs);

    // Extrai XML de retorno
    let xmlString = resultObj?.return?.$value || '';
    if (!xmlString) {
      const scan = (obj) => {
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

    // Se não veio XML, devolve o request enviado para debug
    if (!cotacaoXml) {
      return res.status(200).json({
        debug: true,
        sentArgs: soapArgs,
        lastRequestSnippet: client.lastRequest?.slice?.(0, 2000) || null,
        resultObj
      });
    }

    const erro = parseInt(getTag(cotacaoXml, 'erro') || '0', 10);
    const mensagem = getTag(cotacaoXml, 'mensagem') || '';
    const fretePt = getTag(cotacaoXml, 'frete');
    const prazo = parseInt(getTag(cotacaoXml, 'prazo') || '0', 10);
    const cotacaoNum = getTag(cotacaoXml, 'cotacao') || '';
    const token = getTag(cotacaoXml, 'token') || '';
    const valorFrete = decFromPt(fretePt);

    if (Number.isFinite(erro) && erro !== 0) {
      // >>>>>> AQUI devolvemos também o envelope enviado <<<<<<
      return res.status(422).json({
        error: 'SSW retornou erro',
        ssw: { erro, mensagem },
        detalhes: { cotacaoXml },
        sentArgs: soapArgs,
        lastRequestSnippet: client.lastRequest?.slice?.(0, 2000) || null
      });
    }

    return res.status(200).json({
      ok: true,
      valorFrete,
      prazoEntrega: prazo,
      numeroCotacao: cotacaoNum,
      token,
      mensagem
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      error: status === 400 ? 'Entrada inválida' : 'Erro ao consultar cotação na SSW',
      details: err.message
    });
  }
}
