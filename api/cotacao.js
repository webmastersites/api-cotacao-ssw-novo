import { createClientAsync } from 'soap';

// ---- Helpers gerais ----
const toStr = v => (v ?? '').toString().trim();
const dec = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = toStr(v).replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(toStr(v).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

// ---- Sanitização/validação da entrada ----
function sanitizeCotacaoInput(raw) {
  const i = { ...raw };

  i.dominio = toStr(i.dominio);
  i.login = toStr(i.login);
  i.senha = toStr(i.senha);

  i.cnpjPagador = toStr(i.cnpjPagador).replace(/\D/g, '');
  i.cnpjRemetente = toStr(i.cnpjRemetente).replace(/\D/g, '');
  i.cnpjDestinatario = toStr(i.cnpjDestinatario).replace(/\D/g, '');
  i.cepOrigem = toStr(i.cepOrigem).replace(/\D/g, '');
  i.cepDestino = toStr(i.cepDestino).replace(/\D/g, '');

  i.valorNF = dec(i.valorNF) ?? 0;
  i.quantidade = int(i.quantidade) ?? 1;
  i.peso = dec(i.peso) ?? 0;

  i.altura = dec(i.altura);
  i.largura = dec(i.largura);
  i.comprimento = dec(i.comprimento);

  const volumeInformado = dec(i.volume);
  if (volumeInformado && volumeInformado > 0) {
    i.volume = Number(volumeInformado.toFixed(4));
  } else if ([i.altura, i.largura, i.comprimento].every(v => typeof v === 'number' && v > 0)) {
    i.volume = Number((i.altura * i.largura * i.comprimento * i.quantidade).toFixed(4));
  } else {
    i.volume = 0;
  }

  i.ciffob = toStr(i.ciffob || i.cifFob).toUpperCase().replace(/[^CF]/g, '').charAt(0) || 'F';

  i.coletar = toStr(i.coletar).toUpperCase().startsWith('S') ? 'S' : '';
  i.entDificil = toStr(i.entDificil).toUpperCase().startsWith('S') ? 'S' : '';
  i.observacao = toStr(i.observacao).slice(0, 195);

  return i;
}

function validateForSSW(i) {
  const erros = [];
  if (!i.dominio) erros.push('dominio é obrigatório');
  if (!i.login) erros.push('login é obrigatório');
  if (!i.senha) erros.push('senha é obrigatória');
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

// ---- Parse simples do XML <cotacao> retornado pelo SSW ----
// o WSDL sswCotacaoColeta devolve uma *string com XML*, ex.:
// <cotacao><erro>0</erro><mensagem>OK</mensagem><frete>168,28</frete>...</cotacao>
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

// ------------------------ Handler HTTP ------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // Mapeia seu payload → nomes esperados pelo SSW
  const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const mapped = {
    dominio: raw.dominio,
    login: raw.login,
    senha: raw.senha,
    cnpjPagador: raw.cnpjPagador,
    senhaPagador: raw.senhaPagador,
    cepOrigem: raw.cepOrigem,
    cepDestino: raw.cepDestino,
    peso: raw.peso,
    volume: raw.volume,
    ciffob: raw.ciffob,
    altura: raw.altura,
    largura: raw.largura,
    comprimento: raw.comprimento,
    observacao: raw.observacao,
    tipoFrete: raw.tipoFrete,
    tipoEntrega: raw.tipoEntrega,
    mercadoria: raw.mercadoria ?? '1',

    // renomeados
    valorNF: raw.valorMercadoria,
    quantidade: raw.quantidadeVolumes,
    cnpjRemetente: raw.remetente?.cnpj,
    cnpjDestinatario: raw.destinatario?.cnpj,
  };

  let input;
  try {
    input = validateForSSW(sanitizeCotacaoInput(mapped));
  } catch (err) {
    return res.status(err.status || 400).json({ error: 'Entrada inválida', details: err.message });
  }

  input.mercadoria = input.mercadoria || '1';

  // >>> WSDL correta do sswCotacaoColeta
  const soapUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';

  const soapArgs = {
    dominio: input.dominio,
    login: input.login,
    senha: input.senha,
    cnpjPagador: input.cnpjPagador,
    senhaPagador: input.senhaPagador,
    cepOrigem: input.cepOrigem,
    cepDestino: input.cepDestino,
    valorNF: input.valorNF,
    quantidade: input.quantidade,
    peso: input.peso,
    volume: input.volume,
    mercadoria: input.mercadoria,
    ciffob: input.ciffob,
    tipoFrete: input.tipoFrete,
    tipoEntrega: input.tipoEntrega,
    observacao: input.observacao,
    cnpjRemetente: input.cnpjRemetente,
    cnpjDestinatario: input.cnpjDestinatario,
    altura: input.altura,
    largura: input.largura,
    comprimento: input.comprimento
  };

  try {
    const client = await createClientAsync(soapUrl);

    // métodos possíveis conforme help: cotar() / cotarSite()
    const methodName =
      (client.cotarAsync && 'cotarAsync') ||
      (client.CotarAsync && 'CotarAsync') ||
      (client.cotarSiteAsync && 'cotarSiteAsync') ||
      (client.CotarSiteAsync && 'CotarSiteAsync');

    if (!methodName) {
      throw new Error('Método SOAP não encontrado no WSDL (esperado: cotar/cotarSite).');
    }

    // node-soap retorna [resultObject, rawXml, soapHeader]
    const [resultObj, rawXml] = await client[methodName](soapArgs);

    // 1) tenta pegar string XML do próprio result (propriedade com XML)
    let xmlString = null;
    if (typeof resultObj === 'string') {
      xmlString = resultObj;
    } else {
      const stringProps = Object.values(resultObj || {}).filter(v => typeof v === 'string');
      // pega a primeira string que contenha <cotacao>...</cotacao>
      xmlString = stringProps.find(s => /<cotacao[\s\S]*?<\/cotacao>/i.test(s)) || null;
    }

    // 2) se não achar no result, tenta extrair do rawXml (envelope SOAP inteiro)
    if (!xmlString && typeof rawXml === 'string') {
      xmlString = extractCotacaoXml(rawXml);
    }

    if (!xmlString) {
      // retorna tudo para debug se não encontrou o XML esperado
      console.log('DEBUG SSW: resultObj=', JSON.stringify(resultObj), 'RAW=', rawXml?.slice?.(0, 500));
      return res.status(200).json({ debug: { resultObj, rawSnippet: typeof rawXml === 'string' ? rawXml.slice(0, 1000) : rawXml } });
    }

    // Extrai campos do XML <cotacao>
    const cotacaoXml = extractCotacaoXml(xmlString) || xmlString;
    const erro = int(getTag(cotacaoXml, 'erro'));
    const mensagem = toStr(getTag(cotacaoXml, 'mensagem'));
    const fretePt = getTag(cotacaoXml, 'frete');
    const prazo = int(getTag(cotacaoXml, 'prazo'));
    const cotacaoNum = toStr(getTag(cotacaoXml, 'cotacao'));
    const token = toStr(getTag(cotacaoXml, 'token'));

    const valorFrete = decFromPt(fretePt);

    return res.status(200).json({
      ok: true,
      erro,
      mensagem,
      valorFrete,
      prazoEntrega: prazo,
      numeroCotacao: cotacaoNum,
      token,
      xml: cotacaoXml // mantém bruto para auditoria
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
