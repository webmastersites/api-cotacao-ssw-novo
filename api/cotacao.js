import { createClientAsync } from 'soap';
import { parseStringPromise } from 'xml2js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const {
      cnpjPagador,
      cepOrigem,
      cepDestino,
      valorMercadoria,
      quantidadeVolumes,
      peso,
      volume,
      mercadoria,
      ciffob,
      remetente,
      destinatario,
      observacao,
      altura,
      largura,
      comprimento
    } = req.body;

    // Função para normalizar número decimal
    const norm = (val, casas) => {
      if (val === undefined || val === null || val === '') return undefined;
      let num = parseFloat(
        String(val).replace(',', '.').replace(/[^0-9.]/g, '')
      );
      if (isNaN(num)) return undefined;
      return parseFloat(num.toFixed(casas));
    };

    // Normalizações
    const pesoNorm = norm(peso, 3);
    const volumeNorm = norm(volume, 4);
    const alturaNorm = norm(altura, 3);
    const larguraNorm = norm(largura, 3);
    const comprimentoNorm = norm(comprimento, 3);
    const valorNFNorm = norm(valorMercadoria, 2);

    const args = {
      dominio: 'ost',
      login: 'cotawa',
      senha: '123456',
      cnpjPagador,
      senhaPagador: '1234',
      cepOrigem,
      cepDestino,
      valorNF: valorNFNorm,
      quantidade: parseInt(quantidadeVolumes) || 1,
      peso: pesoNorm,
      volume: volumeNorm,
      mercadoria: mercadoria || '1',
      ciffob: (ciffob || '').toUpperCase(),
      cnpjRemetente: remetente?.cnpj,
      cnpjDestinatario: destinatario?.cnpj,
      observacao,
      altura: alturaNorm,
      largura: larguraNorm,
      comprimento: comprimentoNorm
    };

    const soapUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';
    const client = await createClientAsync(soapUrl);

    const [result] = await client.cotarSiteAsync(args);
    const rawXml = result?.return?._ || result?.return || '';

    if (!rawXml) {
      return res.status(422).json({
        error: 'SSW retornou resposta vazia',
        sentArgs: args
      });
    }

    const parsed = await parseStringPromise(rawXml, { explicitArray: false });
    const cotacao = parsed?.cotacao || {};

    if (cotacao.erro && cotacao.erro !== '0') {
      return res.status(422).json({
        error: 'SSW retornou erro',
        ssw: cotacao,
        detalhes: { cotacaoXml: rawXml },
        sentArgs: args
      });
    }

    return res.status(200).json({
      frete: cotacao.frete,
      prazo: cotacao.prazo,
      cotacao: cotacao.cotacao,
      token: cotacao.token,
      mensagem: cotacao.mensagem
    });
  } catch (err) {
    console.error('Erro na requisição SOAP:', err);
    return res.status(500).json({
      error: 'Erro ao consultar cotação na SSW',
      details: err.message
    });
  }
}
