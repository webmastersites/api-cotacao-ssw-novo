import { createClientAsync } from 'soap';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const {
    remetente,
    destinatario,
    cepOrigem,
    cepDestino,
    peso,
    volume,
    frete,
    tipoFrete,
    ciffob,
    valorMercadoria,
    quantidadeVolumes,
    tipoEntrega,
    altura,
    largura,
    comprimento,
    dominio,
    login,
    senha,
    cnpjPagador,
    senhaPagador,
    observacao
  } = req.body;

  const soapUrl = 'https://www.ssw.inf.br/ws_cotacao/ssw_cotacao.asmx?wsdl'; // Produção

  const soapArgs = {
    dominio,
    login,
    senha,
    cnpjPagador,
    senhaPagador,
    cepOrigem,
    cepDestino,
    valorNF: valorMercadoria,
    quantidade: quantidadeVolumes,
    peso,
    volume,
    mercadoria: '1', // padrão exigido pela SSW
    ciffob,
    tipoFrete,
    tipoEntrega,
    observacao,
    cnpjRemetente: remetente?.cnpj,
    cnpjDestinatario: destinatario?.cnpj,
    altura,
    largura,
    comprimento
  };

  try {
    const client = await createClientAsync(soapUrl);
    const [result] = await client.CalculaFreteAsync(soapArgs);
    const resposta = result?.CalculaFreteResult;

    return res.status(200).json({
      valorFrete: resposta?.vlTotal,
      prazoEntrega: resposta?.prazoEntrega,
      numeroCotacao: resposta?.nrCotacao,
    });
  } catch (err) {
    console.error('Erro na requisição SOAP:', err);
    return res.status(500).json({ error: 'Erro ao consultar cotação na SSW' });
  }
}
