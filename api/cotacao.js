export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  res.status(200).json({ message: 'Cotação recebida com sucesso' });
}
