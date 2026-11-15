# Unidade de Saúde — Agendamento e Fila de Espera (Tema 1)

**Problema:** em postos de saúde, o horário de quem falta é desperdiçado enquanto outras pessoas esperam semanas.
**Solução:** cadastro de pacientes/profissionais, agendamento sem conflito de horário, cancelamento (a vaga liberada vai automaticamente para o 1º da fila de espera), agenda do dia e relatório.

## Arquitetura

```
 Navegador ──► frontend (nginx :80) ──/api/──► api (Node :3000) ──► mongo (:27017) ◄── worker (Node, 1x/min)
                 único exposto                  2 réplicas no K8s    só rede interna     marca consultas passadas
                 (8080 / NodePort 30080)                             + volume/PVC        como "concluida"
```
O frontend (nginx) faz proxy de `/api/` para o serviço `api`; assim a API nunca é exposta ao navegador. API e worker acessam o Mongo por `mongodb://mongo:27017`.

## Coleções
- **pacientes**: `_id, nome`
- **profissionais**: `_id, nome, especialidade`
- **consultas**: `_id, pacienteId, pacienteNome, profissionalId, profissionalNome, data (AAAA-MM-DD), horario (HH:MM), dataHora, status (agendada|concluida|cancelada), slot, criadaEm`
  - `slot` = `profissional|data|horario` com **índice único**: impossibilita dois agendamentos no mesmo horário. É removido no cancelamento, liberando a vaga.
- **fila_espera**: `_id, pacienteId, pacienteNome, profissionalId, profissionalNome, data, horario, criadaEm`

## Rodando com Docker Compose
```bash
export DOCKERHUB_USER=seuusuario   # opcional
docker compose up -d --build
# abrir http://localhost:8080 e clicar em "Carregar dados de exemplo"
docker compose logs -f worker      # ver a rotina a cada minuto
```
Teste de volume (D3):
```bash
docker compose rm -sf mongo && docker compose up -d mongo   # recria o container
# os dados continuam na tela
docker compose down -v   # só se quiser apagar tudo, inclusive o volume
```
Provar que o Mongo não está exposto: `docker compose ps` (sem mapeamento de porta no mongo).

## Docker Hub (D4)
```bash
docker login
for s in api worker frontend; do
  docker build -t SEUUSUARIO/saude-$s:v1 ./$s && docker push SEUUSUARIO/saude-$s:v1
done
```

## Kubernetes (kind: 1 control-plane + 2 workers)
```bash
sed -i 's/SEUUSUARIO/seuusuario/g' k8s/*.yaml
kind create cluster --name saude --config k8s/kind-config.yaml
kubectl get nodes
kubectl apply -f k8s/mongo.yaml
kubectl apply -f k8s/api.yaml -f k8s/worker.yaml -f k8s/frontend.yaml
kubectl get pods -o wide && kubectl get svc && kubectl get pvc
# abrir http://localhost:30080
```
### K3 — por que o worker tem 1 réplica?
Com 2+ réplicas, todas executariam a mesma verificação ao mesmo tempo: trabalho duplicado, condições de corrida e, em rotinas que geram registros/alertas, itens duplicados. Ele não atende requisições, então não ganha nada com escala; a disponibilidade vem do Kubernetes recriando o pod (e `strategy: Recreate` evita dois workers durante um update).

### K5 — falha da API
```bash
kubectl get pods -l app=api
kubectl delete pod <nome-de-um-pod-api>
kubectl get pods -l app=api -w        # o pod é recriado
# enquanto isso, recarregar http://localhost:30080: o sistema continua respondendo
```
### K6 — persistência do banco
```bash
kubectl delete pod -l app=mongo
kubectl get pods -l app=mongo -w
# recarregar a página: pacientes/consultas continuam lá
```
### K7 — escala
```bash
kubectl scale deployment api --replicas=3 && kubectl get pods -l app=api
kubectl scale deployment api --replicas=2 && kubectl get pods -l app=api
```
### K8 — atualização v2 e rollback
```bash
docker build --build-arg VERSION=v2 -t SEUUSUARIO/saude-api:v2 ./api && docker push SEUUSUARIO/saude-api:v2
kubectl set image deployment/api api=SEUUSUARIO/saude-api:v2
kubectl rollout status deployment/api     # rolling update, sem interrupção (readinessProbe)
kubectl rollout history deployment/api
kubectl rollout undo deployment/api       # volta para v1
```
(O topo da página mostra a versão da API em uso.)

## Dados de exemplo (R3)
Botão "Carregar dados de exemplo" na tela, ou `curl -X POST http://localhost:8080/api/seed` (Compose) / `http://localhost:30080/api/seed` (K8s).
