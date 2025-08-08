// api/cotacao.js  (CommonJS - compatível com Vercel Node runtime)
// OBS: não use "import" aqui. fetch é global no Node 18+ na Vercel.

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Helpers seguros (sempre trabalham com string)
    const asStr = (v) => (v ?? '').toString();
    const onlyDigits = (v) => asStr(v).replace(/\D+/g, '');
    const fixN = (v, d) => {
      if (v === undefined || v === null || v === '') return '0' + (d ? '.' + '0'.repeat(d) : '');
      const n = Number(asStr(v).replace(',', '.'));
      if (Number.isNaN(n)) return '0' + (d ? '.' + '0'.repeat(d) : '');
      return n.toFixed(d || 0);
    };
    const fix2 = (v) => fixN(v, 2);
    const fix3 = (v) => fixN(v, 3);
    const fix4 = (v) => fixN(v, 4);
    const asInt = (v, def = 1) => {
      const n = parseInt(asStr(v).trim(), 10);
      return Number.isNaN(n) ? def : n;
    };

    // Montagem de argumentos pro SOAP
    const args = {
      dominio: 'OST',
      login: 'cotawa',
      senha: '123456',

      cnpjPagador: onlyDigits(body.cnpjPagador),
      senhaPagador: body.senhaPagador ? asStr(body.senhaPagador) : '1234',

      cepOrigem: onlyDigits(body.cepOrigem),
      cepDestino: onlyDigits(body.cepDestino),

      // API da SSW espera "valorNF"
      valorNF: fix2(body.valorMercadoria ?? body.valorNF),

      quantidade: asInt(body.quantidade, 1),
      peso: fix3(body.peso),
      volume: fix4(body.volume),

      mercadoria: asInt(body.mercadoria, 1),

      ciffob: (body.ciffob || 'F').toString().trim().toUpperCase().startsWith('C') ? 'C' : 'F',

      cnpjRemetente: onlyDigits(body.cnpjRemetente || ''),
      cnpjDestinatario: onlyDigits(body.cnpjDestinatario || ''),

      observacao: asStr(body.observacao || ''),

      altura: fix3(body.altura),
      largura: fix3(body.largura),
      comprimento: fix3(body.comprimento),

      // extras opcionais
      trt: asStr(body.trt || ''),
      coletar: (body.coletar || 'N').toString().trim().toUpperCase() === 'S' ? 'S' : 'N',
      entDificil: asStr(body.entDificil || ''),
      destContribuinte: asStr(body.destContribuinte || ''),
      qtdePares: asStr(body.qtdePares || ''),
      fatorMultiplicador: asStr(body.fatorMultiplicador || '')
    };

    // Construção do envelope SOAP (string pura)
    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"  xmlns:tns="urn:sswinfbr.sswCotacaoColeta">
  <soap:Body>
    <tns:cotarSite>
      <dominio>${args.dominio}</dominio>
      <login>${args.login}</login>
      <senha>${args.senha}</senha>
      <cnpjPagador>${args.cnpjPagador}</cnpjPagador>
      <senhaPagador>${args.senhaPagador}</senhaPagador>
      <cepOrigem>${args.cepOrigem}</cepOrigem>
      <cepDestino>${args.cepDestino}</cepDestino>
      <valorNF>${args.valorNF}</valorNF>
      <quantidade>${args.quantidade}</quantidade>
      <peso>${args.peso}</peso>
      <volume>${args.volume}</volume>
      <mercadoria>${args.mercadoria}</mercadoria>
      <ciffob>${args.ciffob}</ciffob>
      <cnpjRemetente>${args.cnpjRemetente}</cnpjRemetente>
      <cnpjDestinatario>${args.cnpjDestinatario}</cnpjDestinatario>
      <observacao>${args.observacao}</observacao>
      <trt>${args.trt}</trt>
      <coletar>${args.coletar}</coletar>
      <entDificil>${args.entDificil}</entDificil>
      <destContribuinte>${args.destContribuinte}</destContribuinte>
      <qtdePares>${args.qtdePares}</qtdePares>
      <altura>${args.altura}</altura>
      <largura>${args.largura}</largura>
      <comprimento>${args.comprimento}</comprimento>
      <fatorMultiplicador>${args.fatorMultiplicador}</fatorMultiplicador>
    </tns:cotarSite>
  </soap:Body>
</soap:Envelope>`;

    // Chamada SOAP
    const resp = await fetch('https://ssw.inf.br/ws/sswCotacaoColeta/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'urn:sswinfbr.sswCotacaoColeta#cotarSite'
      },
      body: soap,
    });

    const soapText = await resp.text();

    // 1) Tenta capturar <return>...</return>; se não houver, usa o corpo todo
    const returnMatch = soapText.match(/<return[^>]*>([\s\S]*?)<\/return>/i);
    const inner = returnMatch ? returnMatch[1] : soapText;

    // 2) Decodifica entidades HTML (&lt; &gt; &amp; &quot;)
    const decoded = inner
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // 3) Extrai tags do XML interno <cotacao>…</cotacao>
    const getTag = (tag) => {
      const m = decoded.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };

    const erro = getTag('erro');
    const mensagem = getTag('mensagem');
    const frete = getTag('frete');
    const prazo = getTag('prazo');
    const numero = getTag('cotacao');
    const token = getTag('token');

    if (erro === '0' && numero) {
      // Converte "197,45" => 197.45
      const valorFrete = Number((frete || '0').replace(/\./g, '').replace(',', '.'));
      return res.status(200).json({
        ok: true,
        valorFrete,
        prazoEntrega: Number(prazo || 0),
        numeroCotacao: numero,
        token,
        mensagem: mensagem || 'OK',
        lastRequest: soap
      });
    }

    // Caso erro vindo do SSW
    return res.status(422).json({
      error: 'SSW retornou erro',
      ssw: { erro: erro ? Number(erro) : 1, mensagem: mensagem || 'Erro' },
      detalhes: { cotacaoXml: decoded },
      sentArgs: args,
      lastRequest: soap
    });

  } catch (e) {
    // Log básico (aparece no vercel logs)
    console.error('[cotacao] FATAL', e?.stack || e);
    return res.status(500).send('A server error has occurred\n\nFUNCTION_INVOCATION_FAILED');
  } finally {
    // opcional: console.log('[cotacao] took', Date.now() - startedAt, 'ms');
  }
};
