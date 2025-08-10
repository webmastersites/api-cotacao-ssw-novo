// api/coleta.js (CommonJS - Vercel Node 18)
// Operação SOAP: "coletar" (WSDL: urn:sswinfbr.sswCotacaoColeta#coletar)

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // helpers (iguais ao estilo do cotacao.js)
    const asStr = (v) => (v ?? '').toString();
    const onlyDigits = (v) => asStr(v).replace(/\D+/g, '');
    const z = (n) => (n < 10 ? `0${n}` : `${n}`);

    // obrigatórios: dominio, login, senha, cotacao, token, solicitante, e limiteColeta OU (data+hora)
    const faltando = [];
    ['dominio','login','senha','cotacao','token','solicitante'].forEach(k => { if (!body[k]) faltando.push(k); });
    if (!body.limiteColeta && !(body.data && body.hora)) faltando.push('limiteColeta|data+hora');
    if (faltando.length) {
      return res.status(400).json({ ok:false, erro:1, mensagem:`Campos obrigatórios ausentes: ${faltando.join(', ')}` });
    }

    // monta limiteColeta ISO 8601 se veio data/hora
    let limiteColeta = asStr(body.limiteColeta || '');
    if (!limiteColeta) {
      let hora = asStr(body.hora).trim().toLowerCase();
      if (hora === 'padrão' || hora === 'padrao') hora = '17:00';
      const [H, M] = (hora || '17:00').split(':');
      limiteColeta = `${asStr(body.data)}T${z(parseInt(H||'17',10))}:${z(parseInt(M||'00',10))}:00`;
    }

    const args = {
      dominio: asStr(body.dominio),
      login: asStr(body.login),
      senha: asStr(body.senha),
      cotacao: onlyDigits(body.cotacao),
      limiteColeta: asStr(limiteColeta),
      token: asStr(body.token),
      solicitante: asStr(body.solicitante),
      observacao: asStr(body.observacao || ''),
      chaveNFe: asStr(body.chaveNFe || ''),
      nroPedido: asStr(body.nroPedido || '')
    };

    // envelope SOAP (RPC/encoded)
    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="urn:sswinfbr.sswCotacaoColeta">
  <soap:Body>
    <tns:coletar>
      <dominio>${args.dominio}</dominio>
      <login>${args.login}</login>
      <senha>${args.senha}</senha>
      <cotacao>${args.cotacao}</cotacao>
      <limiteColeta>${args.limiteColeta}</limiteColeta>
      <token>${args.token}</token>
      <solicitante>${args.solicitante}</solicitante>
      <observacao>${args.observacao}</observacao>
      <chaveNFe>${args.chaveNFe}</chaveNFe>
      <nroPedido>${args.nroPedido}</nroPedido>
    </tns:coletar>
  </soap:Body>
</soap:Envelope>`;

    const resp = await fetch('https://ssw.inf.br/ws/sswCotacaoColeta/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'urn:sswinfbr.sswCotacaoColeta#coletar'
      },
      body: soap,
    });

    const soapText = await resp.text();

    // pega <return> e decodifica entidades HTML
    const returnMatch = soapText.match(/<return[^>]*>([\s\S]*?)<\/return>/i);
    const inner = returnMatch ? returnMatch[1] : soapText;
    const decoded = inner.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"');

    const getTag = (tag) => {
      const m = decoded.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };

    const erro = getTag('erro') || getTag('codigo');
    const mensagem = getTag('mensagem') || getTag('msg');
    const protocolo = getTag('protocoloColeta') || getTag('protocolo');
    const ok = !erro || /^0$|^OK$/i.test(erro);

    return res.status(ok ? 200 : 422).json({
      ok,
      mensagem: mensagem || (ok ? 'OK' : 'Erro'),
      protocolo,
      sentArgs: { ...args, senha: '***', token: '***' },
      lastRequest: soap,
      lastResponse: decoded
    });

  } catch (e) {
    console.error('[coleta] FATAL', e?.stack || e);
    return res.status(500).send('A server error has occurred\n\nFUNCTION_INVOCATION_FAILED');
  } finally {
    // console.log('[coleta] took', Date.now() - startedAt, 'ms');
  }
};
