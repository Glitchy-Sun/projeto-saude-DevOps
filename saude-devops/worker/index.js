const http = require('http');
const { MongoClient } = require('mongodb');
const URL = process.env.MONGO_URL || 'mongodb://mongo:27017';
let db;

async function conectar() {
  for (;;) {
    try { const c = new MongoClient(URL, { serverSelectionTimeoutMS: 3000 }); await c.connect(); return c.db('saude'); }
    catch (e) { console.log('Aguardando MongoDB...'); await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function verificar() {
  try {
    const r = await db.collection('consultas').updateMany(
      { status: 'agendada', dataHora: { $lt: new Date() } },
      { $set: { status: 'concluida', concluidaEm: new Date() } });
    console.log(new Date().toISOString(), `consultas concluídas: ${r.modifiedCount}`);
  } catch (e) { console.error('erro na verificação', e.message); }
}

// endpoint simples só para o Service do Kubernetes
http.createServer((req, res) => { res.end('worker ok'); }).listen(8080);

conectar().then(d => { db = d; verificar(); setInterval(verificar, 60 * 1000); });
