const soap = require('soap');

const WSDL = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php?wsdl';
const ENDPOINT = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php';

(async () => {
  try {
    const client = await soap.createClientAsync(WSDL);
    client.setEndpoint(ENDPOINT);
    console.dir(client.describe(), { depth: null });
  } catch (err) {
    console.error('Erro ao criar client SOAP:', err);
    process.exit(1);
  }
})();
