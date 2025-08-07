import { createClientAsync } from 'soap';

// ---- Sanitização e normalização de entrada (helpers) ----
const toStr = v => (v ?? '').toString().trim();

const dec = (v) => {
  if (v === undefined || v === null || v === '') return null;
  // remove separador de milhar "." e troca vírgula por ponto
  const s = toStr(v).replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const int = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(toStr(v).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

function sanitizeCotacaoInput(raw) {
  const i = { ...raw };

  // credenciais e básicos
  i.dominio = toStr(i.dominio);
  i.login = toStr(i.login);
  i.senha = toStr(i.senha);

  // CNPJs / CEPs só dígitos
  i.cnpjPagador = toStr(i.cnpjPagador).replace(/\D/g, '');
  i.cnpjRemetente = toStr(i.cnpjRemetente).replace(/\D/g, '');
  i.cnpjDestinatario = toStr(i.cnpjDestinatario).replace(/\D/g, '');
  i.cepOrigem = toStr(i.cepOrigem).replace(/\D/g, '');
  i.cepDestino = toStr(i.cepDestino).replace(/\D/g, '');

  // numéricos
  i.valorNF = dec(i.valorNF) ?? 0;
  i.quantidade = int(i.quantidade) ?? 1;
  i.peso = dec(i.peso) ?? 0;

  // dimensões (em metros)
  i.altura = dec(i.altura);
  i.largura = dec(i.largura);
  i.comprimento = dec(i.comprimento);

  // volume: usa o informado se > 0; senão calcula de A*L*C*qtd
  const volumeInformado = dec(i.volume);
  if (volumeInformado && volumeInformado > 0) {
    i.volume = Number(volumeInformado.toFixed(4));
  } else if ([i.altura, i.largura, i.comprimento].every(v => typeof v === 'number' && v > 0)) {
    i.volume = Number((i.altura * i.largura * i.comprimento * i.quantidade).toFixed(4));
  } else {
    i.volume = 0;
  }

  // CIF/FOB -> C ou F
  i.ciffob = toStr(i.ciffob || i.cifFob)
    .toUpperCase()
    .replace(/[^CF]/g, '')
    .charAt(0) || 'F';

  // flags e observação
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
  // informar peso ou volume; não podem ambos estar zerados
  if ((i.peso ?? 0) <= 0 && (i.volume ?? 0) <= 0) {
    erros.push('informe peso (>0) ou volume (>0)');
  }
  if (!['C', 'F'].includes(i.ciffob)) erros.push('ciffob deve ser C ou F');
  if (erros.length) {
    const e = new Error(erros.join('; '));
    e.status = 400;
    throw e;
  }
  return i;
}

// ------------------------ Handler HTTP ------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // --- Lê o body, mapeia nomes do seu payload -> nomes esperados, normaliza e valida
  const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  const mapped = {
    // iguais
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

    // diferentes → mapeados
    valorNF: raw.valorMercadoria,
    quantidade: raw.quantidadeVolumes,
    cnpjRemetente: raw.remetente?.cnpj,
    cnpjDestinatario: raw.destinatario?.cnpj,
  };

  let input;
  try {
    input = validateForSSW(sanitizeCotacaoInput(mapped));
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({
      error: 'Entrada inválida',
      details: err.message
    });
  }

  // garante mercadoria padrão exigido pela SSW
  input.mercadoria = input.mercadoria || '1';

  // >>> WSDL CORRETA <<<
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
    mercadoria: input.mercadoria, // '1'
    ciffob: input.ciffob,         // 'C' ou 'F'
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

    // Descobre o método exposto neste WSDL
    const methodName =
      (client.cotarAsync && 'cotarAsync') ||
      (client.CotarAsync && 'CotarAsync') ||
      (client.cotarSiteAsync && 'cotarSiteAsync') ||
      (client.CotarSiteAsync && 'CotarSiteAsync') ||
      (client.CalculaFreteAsync && 'CalculaFreteAsync');

    if (!methodName) {
      throw new Error('Método SOAP não encontrado no WSDL (esperado: cotar ou cotarSite).');
    }

    const [result] = await client[methodName](soapArgs);

    // Normaliza o nó de resultado
    const resposta =
      result?.cotarResult ??
      result?.CotarResult ??
      result?.cotarSiteResult ??
      result?.CotarSiteResult ??
      result?.CalculaFreteResult ??
      result;

    return res.status(200).json({
      valorFrete: resposta?.vlTotal ?? resposta?.valorFrete ?? resposta?.vlFrete,
      prazoEntrega: resposta?.prazoEntrega ?? resposta?.prazo,
      numeroCotacao: resposta?.nrCotacao ?? resposta?.cotacao ?? resposta?.numeroCotacao,
      token: resposta?.token // geralmente retornado por sswCotacaoColeta, útil para coleta posterior
    });
  } catch (err) {
    const status = err.status || 500;
    console.error('[cotacao][erro]', {
      status,
      message: err.message,
      stack: err.stack,
    });
    return res.status(status).json({
      error: status === 400 ? 'Entrada inválida' : 'Erro ao consultar cotação na SSW',
      details: err.message
    });
  }
}
