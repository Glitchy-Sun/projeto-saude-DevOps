const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const URL = process.env.MONGO_URL || 'mongodb://mongo:27017';
const app = express();
app.use(express.json());
let db;

const h = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ erro: 'erro interno' }); });
const ok = id => ObjectId.isValid(id);
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const horaOk = t => /^\d{2}:\d{2}$/.test(t || '');
const slotDe = (p, d, t) => `${p}|${d}|${t}`;
const toDate = (d, t) => new Date(`${d}T${t}:00-03:00`);

async function conectar() {
  for (;;) {
    try { const c = new MongoClient(URL, { serverSelectionTimeoutMS: 3000 }); await c.connect(); return c.db('saude'); }
    catch (e) { console.log('Aguardando MongoDB...'); await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function criarConsulta(pac, prof, data, horario) {
  const doc = {
    pacienteId: pac._id, pacienteNome: pac.nome,
    profissionalId: prof._id, profissionalNome: prof.nome,
    data, horario, dataHora: toDate(data, horario),
    status: 'agendada', slot: slotDe(prof._id, data, horario), criadaEm: new Date()
  };
  await db.collection('consultas').insertOne(doc); // índice único em "slot" impede duplicidade
  return doc;
}

app.get('/api/health', h(async (req, res) => { await db.command({ ping: 1 }); res.json({ status: 'ok', pod: process.env.HOSTNAME }); }));
app.get('/api/version', (req, res) => res.json({ versao: process.env.APP_VERSION || 'dev', pod: process.env.HOSTNAME }));

app.post('/api/pacientes', h(async (req, res) => {
  if (!req.body.nome) return res.status(400).json({ erro: 'nome obrigatório' });
  const r = await db.collection('pacientes').insertOne({ nome: req.body.nome });
  res.status(201).json({ _id: r.insertedId, nome: req.body.nome });
}));
app.get('/api/pacientes', h(async (req, res) => res.json(await db.collection('pacientes').find().sort({ nome: 1 }).toArray())));

app.post('/api/profissionais', h(async (req, res) => {
  const { nome, especialidade } = req.body;
  if (!nome || !especialidade) return res.status(400).json({ erro: 'nome e especialidade obrigatórios' });
  const r = await db.collection('profissionais').insertOne({ nome, especialidade });
  res.status(201).json({ _id: r.insertedId, nome, especialidade });
}));
app.get('/api/profissionais', h(async (req, res) => res.json(await db.collection('profissionais').find().sort({ nome: 1 }).toArray())));

app.post('/api/consultas', h(async (req, res) => {
  const { pacienteId, profissionalId, data, horario } = req.body;
  if (!ok(pacienteId) || !ok(profissionalId) || !dataOk(data) || !horaOk(horario))
    return res.status(400).json({ erro: 'dados inválidos' });
  const pac = await db.collection('pacientes').findOne({ _id: new ObjectId(pacienteId) });
  const prof = await db.collection('profissionais').findOne({ _id: new ObjectId(profissionalId) });
  if (!pac || !prof) return res.status(404).json({ erro: 'paciente ou profissional não encontrado' });
  try { res.status(201).json(await criarConsulta(pac, prof, data, horario)); }
  catch (e) {
    if (e.code === 11000) return res.status(409).json({ erro: 'Horário já ocupado para este profissional. Entre na fila de espera.' });
    throw e;
  }
}));

// Cancelamento + promoção automática do primeiro da fila de espera
app.delete('/api/consultas/:id', h(async (req, res) => {
  if (!ok(req.params.id)) return res.status(400).json({ erro: 'id inválido' });
  const c = await db.collection('consultas').findOneAndUpdate(
    { _id: new ObjectId(req.params.id), status: 'agendada' },
    { $set: { status: 'cancelada', canceladaEm: new Date() }, $unset: { slot: '' } });
  if (!c) return res.status(404).json({ erro: 'consulta não encontrada ou não pode ser cancelada' });
  let promovido = null;
  const f = await db.collection('fila_espera').findOneAndDelete(
    { profissionalId: c.profissionalId, data: c.data, horario: c.horario }, { sort: { criadaEm: 1 } });
  if (f) {
    const pac = await db.collection('pacientes').findOne({ _id: f.pacienteId });
    const prof = await db.collection('profissionais').findOne({ _id: f.profissionalId });
    if (pac && prof) { try { promovido = await criarConsulta(pac, prof, c.data, c.horario); } catch (e) { console.error(e); } }
  }
  res.json({ cancelada: true, promovidoDaFila: promovido ? promovido.pacienteNome : null });
}));

app.get('/api/agenda', h(async (req, res) => {
  const { profissionalId, data } = req.query;
  if (!ok(profissionalId) || !dataOk(data)) return res.status(400).json({ erro: 'informe profissionalId e data (AAAA-MM-DD)' });
  res.json(await db.collection('consultas')
    .find({ profissionalId: new ObjectId(profissionalId), data, status: { $ne: 'cancelada' } }).sort({ horario: 1 }).toArray());
}));

app.post('/api/fila', h(async (req, res) => {
  const { pacienteId, profissionalId, data, horario } = req.body;
  if (!ok(pacienteId) || !ok(profissionalId) || !dataOk(data) || !horaOk(horario)) return res.status(400).json({ erro: 'dados inválidos' });
  const pac = await db.collection('pacientes').findOne({ _id: new ObjectId(pacienteId) });
  const prof = await db.collection('profissionais').findOne({ _id: new ObjectId(profissionalId) });
  if (!pac || !prof) return res.status(404).json({ erro: 'paciente ou profissional não encontrado' });
  await db.collection('fila_espera').insertOne({ pacienteId: pac._id, pacienteNome: pac.nome, profissionalId: prof._id, profissionalNome: prof.nome, data, horario, criadaEm: new Date() });
  res.status(201).json({ ok: true });
}));
app.get('/api/fila', h(async (req, res) => res.json(await db.collection('fila_espera').find().sort({ criadaEm: 1 }).toArray())));

app.get('/api/relatorio', h(async (req, res) => {
  res.json(await db.collection('consultas').aggregate([
    { $match: { status: { $ne: 'cancelada' } } },
    { $group: { _id: '$profissionalId', profissional: { $first: '$profissionalNome' }, total: { $sum: 1 },
        concluidas: { $sum: { $cond: [{ $eq: ['$status', 'concluida'] }, 1, 0] } } } },
    { $sort: { profissional: 1 } }
  ]).toArray());
}));

// Dados de exemplo (R3)
app.post('/api/seed', h(async (req, res) => {
  for (const c of ['pacientes', 'profissionais', 'consultas', 'fila_espera']) await db.collection(c).deleteMany({});
  const pacs = (await db.collection('pacientes').insertMany([{ nome: 'Maria Silva' }, { nome: 'João Souza' }, { nome: 'Ana Costa' }])).insertedIds;
  const profs = (await db.collection('profissionais').insertMany([{ nome: 'Dr. Carlos Lima', especialidade: 'Clínico Geral' }, { nome: 'Dra. Paula Reis', especialidade: 'Pediatria' }])).insertedIds;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const ontem = new Date(Date.now() - 27 * 3600e3).toISOString().slice(0, 10);
  const get = async (col, id) => db.collection(col).findOne({ _id: id });
  const lista = [[0, 0, ontem, '08:00'], [1, 0, hoje, '23:00'], [2, 1, hoje, '23:30']];
  for (const [i, j, d, t] of lista) await criarConsulta(await get('pacientes', pacs[i]), await get('profissionais', profs[j]), d, t);
  res.json({ ok: true, mensagem: 'dados de exemplo carregados (a consulta de ontem será marcada como concluída pelo worker)' });
}));

conectar().then(async d => {
  db = d;
  await db.collection('consultas').createIndex({ slot: 1 }, { unique: true, sparse: true });
  app.listen(3000, () => console.log('API na porta 3000 - versão', process.env.APP_VERSION));
});
