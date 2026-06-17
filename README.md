# Doculoc API

API backend para análise cadastral de locação, controle de créditos de consulta, contestação, aprovação manual por administrador, recuperação de senha, geração de contratos `.docx` e armazenamento local ou S3-compatible/Cloudflare R2.

---

## Sumário

- [Visão geral](#visão-geral)
- [Tecnologias](#tecnologias)
- [Requisitos](#requisitos)
- [Arquitetura de pastas](#arquitetura-de-pastas)
- [Fluxo de negócio](#fluxo-de-negócio)
- [Modelo de dados principal](#modelo-de-dados-principal)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Rodando localmente](#rodando-localmente)
- [PostgreSQL local com Docker](#postgresql-local-com-docker)
- [Prisma](#prisma)
- [Cloudflare R2 / S3-compatible storage](#cloudflare-r2--s3-compatible-storage)
- [Autenticação](#autenticação)
- [Rotas](#rotas)
- [Deploy no Render](#deploy-no-render)
- [Troubleshooting](#troubleshooting)
- [Boas práticas de segurança](#boas-práticas-de-segurança)

---

## Visão geral

O Doculoc API é o backend responsável por:

- Cadastro e login de usuários.
- Perfis `ADMIN` e `REAL_ESTATE`.
- Cadastro de perfil da imobiliária.
- Recuperação de senha via e-mail.
- Consulta cadastral de CPF/CNPJ via Órago.
- Pré-análise automática de risco para locação.
- Controle de créditos de consulta.
- Usuários VIP com consultas ilimitadas.
- Bloqueio contra consulta duplicada do mesmo CPF/CNPJ.
- Contestação de consultas reprovadas.
- Aprovação/reprovação manual pelo administrador.
- Preenchimento de dados de locatário e imóvel.
- Geração de contrato `.docx` via template.
- Download de contratos armazenados localmente ou em Cloudflare R2/S3-compatible storage.

---

## Tecnologias

- Node.js 22
- Express
- TypeScript
- Prisma ORM
- PostgreSQL
- JWT
- Zod
- BcryptJS
- Docxtemplater
- PizZip
- AWS SDK S3
- Cloudflare R2 / S3-compatible storage
- Resend para envio de e-mails
- Render para deploy sugerido

---

## Requisitos

Para desenvolvimento local:

- Node.js 22+
- npm
- Docker e Docker Compose, caso use PostgreSQL local via Docker
- Conta/token da API Órago
- Opcional: conta Cloudflare com R2 configurado
- Opcional: conta Resend para recuperação de senha

Verifique a versão do Node:

```bash
node -v
```

O projeto declara:

```json
"engines": {
  "node": "22.x"
}
```

---

## Arquitetura de pastas

Estrutura principal:

```txt
src/
  app.ts
  server.ts

  config/
    env.ts

  controllers/
    auth.controller.ts
    contract.controller.ts
    credit.controller.ts
    rental-application.controller.ts

  domain/
    roles.ts

  lib/
    prisma.ts

  middlewares/
    async-handler.ts
    auth.ts
    error-handler.ts

  routes/
    auth.routes.ts
    contract.routes.ts
    credit.routes.ts
    index.routes.ts
    rental-application.routes.ts
    system.routes.ts

  schemas/
    auth.schemas.ts
    consults.schemas.ts
    credit.schemas.ts
    document.schemas.ts
    rental-application.schemas.ts

  services/
    contract.service.ts
    credit.service.ts
    mail.service.ts
    orago-client.ts
    rental-application.service.ts
    storage.service.ts

  templates/
    default-rental-application-contract.docx

  types/
    express.d.ts

  utils/
    build-password-reset-email.ts
    calculate-housing-expense-from-income.ts
    calculate-pj-housing-expense.ts
    evaluate-pf-tenant.ts
    evaluate-pj-tenant.ts
    evaluate-tenant.ts
    extract-applicant-name.ts
    get-recommendation-from-structured-data.ts
    hash-token.ts
    parse-brazilian-currency.ts
    parse-currency-range.ts
    parse-number.ts
    parse-percentage.ts
```

---

## Fluxo de negócio

### Consulta aprovada automaticamente

```txt
Imobiliária faz consulta CPF/CNPJ
  ↓
Backend cria lock da consulta
  ↓
Backend consulta API Órago
  ↓
Backend coleta resultado
  ↓
Backend avalia decisão automática
  ↓
Cria RentalApplication
  ↓
Consome 1 crédito, exceto usuário VIP
  ↓
Status: WAITING_CONTRACT_DATA
  ↓
Imobiliária preenche dados do contrato
  ↓
Status: WAITING_ADMIN_CONTRACT
  ↓
Admin pode revisar aluguel, condomínio e IPTU
  ↓
Admin gera contrato
  ↓
Status: CONTRACT_GENERATED
```

### Consulta reprovada automaticamente

```txt
Imobiliária faz consulta CPF/CNPJ
  ↓
Backend avalia risco
  ↓
Status: REJECTED
  ↓
Imobiliária pode contestar
  ↓
Status: CONTESTED
  ↓
Admin aprova ou reprova manualmente
```

### Aprovação manual pelo admin

```txt
Consulta REJECTED ou CONTESTED
  ↓
Admin decide APPROVED
  ↓
Status: WAITING_CONTRACT_DATA
  ↓
Imobiliária pode preencher dados do contrato
```

---

## Modelo de dados principal

### User

Representa um usuário do sistema.

Perfis:

```txt
ADMIN
REAL_ESTATE
```

### RealEstateProfile

Perfil complementar para usuários `REAL_ESTATE`:

- Nome da imobiliária
- CNPJ opcional
- Telefone
- Responsável

### UserCreditWallet

Carteira de créditos da imobiliária:

```txt
availableCredits: número de consultas disponíveis
isVip: se true, não consome créditos
```

### CreditLedger

Histórico de movimentações de crédito:

```txt
INITIAL_GRANT
ADMIN_SET
ADMIN_INCREMENT
ADMIN_DECREMENT
CONSULT_USED
VIP_ENABLED
VIP_DISABLED
```

### OragoConsultLock

Controle para evitar consultas simultâneas/duplicadas do mesmo CPF/CNPJ.

Status:

```txt
PROCESSING
COMPLETED
FAILED
```

### RentalApplication

Entidade principal do fluxo de locação.

Status possíveis:

```txt
CONSULTED
WAITING_CONTRACT_DATA
WAITING_ADMIN_CONTRACT
CONTRACT_GENERATED
REJECTED
CONTESTED
ADMIN_REJECTED
CANCELLED
```

### RentalApplicationContest

Contestação enviada pela imobiliária para uma consulta reprovada.

Status:

```txt
OPEN
ACCEPTED
REJECTED
CANCELLED
```

### Contract

Contrato gerado a partir de template `.docx`.

Pode ser armazenado:

```txt
local
r2
s3
```

Campos importantes:

```txt
filePath       usado quando STORAGE_DRIVER=local
storageBucket  bucket remoto
storageKey     chave do arquivo no R2/S3
mimeType       tipo do arquivo
sizeBytes      tamanho do arquivo
```

---

## Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto com base no `.env.example`.

Exemplo local:

```env
NODE_ENV=development
PORT=3333
HOST="127.0.0.1"

DATABASE_URL="postgresql://doculoc:doculoc@localhost:5432/doculoc?schema=public"

JWT_SECRET="troque-por-um-segredo-com-pelo-menos-24-caracteres"

ORAGO_BASE_URL="https://sandbox.oragoapp.com.br"
ORAGO_API_TOKEN="cole-sua-chave-sandbox-ou-producao"

CONTRACT_TEMPLATE_PATH=src/templates/default-rental-application-contract.docx

STORAGE_DRIVER=local
CONTRACT_OUTPUT_DIR=storage/contracts

S3_ENDPOINT=
S3_REGION=auto
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

CORS_ORIGIN="http://localhost:5173"
APP_URL="http://localhost:5173"

RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxxxxxxx"
MAIL_FROM="Doculoc <noreply@doculoc.com.br>"
PASSWORD_RESET_TOKEN_EXPIRES_MINUTES=60
```

### Descrição das variáveis

| Variável | Obrigatória | Descrição |
|---|---:|---|
| `NODE_ENV` | Sim | `development`, `test` ou `production`. |
| `PORT` | Sim | Porta da API. |
| `HOST` | Sim | Host de bind. Use `0.0.0.0` em produção no Render. |
| `DATABASE_URL` | Sim | URL PostgreSQL usada pelo Prisma. |
| `JWT_SECRET` | Sim | Segredo JWT com no mínimo 24 caracteres. |
| `ORAGO_BASE_URL` | Sim | URL base da API Órago. |
| `ORAGO_API_TOKEN` | Sim | Token da API Órago. |
| `CONTRACT_TEMPLATE_PATH` | Sim | Caminho do template `.docx`. |
| `STORAGE_DRIVER` | Sim | `local`, `r2` ou `s3`. |
| `CONTRACT_OUTPUT_DIR` | Sim para local | Pasta local para contratos quando `STORAGE_DRIVER=local`. |
| `S3_ENDPOINT` | Sim para R2/S3 | Endpoint S3-compatible. |
| `S3_REGION` | Sim para R2/S3 | Use `auto` para Cloudflare R2. |
| `S3_BUCKET` | Sim para R2/S3 | Nome do bucket. |
| `S3_ACCESS_KEY_ID` | Sim para R2/S3 | Access Key ID do bucket. |
| `S3_SECRET_ACCESS_KEY` | Sim para R2/S3 | Secret Access Key do bucket. |
| `CORS_ORIGIN` | Recomendado | URL do frontend autorizada no CORS. |
| `APP_URL` | Sim para reset de senha | URL base do frontend para links de reset. |
| `RESEND_API_KEY` | Sim para e-mail real | API key do Resend. |
| `MAIL_FROM` | Sim para e-mail real | Remetente dos e-mails. |
| `PASSWORD_RESET_TOKEN_EXPIRES_MINUTES` | Não | Tempo de expiração do reset de senha. |

---

## Rodando localmente

Instale dependências:

```bash
npm install
```

Gere o Prisma Client:

```bash
npm run prisma:generate
```

Rode as migrations:

```bash
npm run prisma:migrate
```

Inicie o servidor em desenvolvimento:

```bash
npm run dev
```

API local:

```txt
http://localhost:3333
```

Health check:

```http
GET /health
```

---

## PostgreSQL local com Docker

O projeto já possui `docker-compose.yml`. Caso necessário, use um compose como este:

```yml
services:
  postgres:
    image: postgres:16
    container_name: doculoc-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: doculoc
      POSTGRES_PASSWORD: doculoc
      POSTGRES_DB: doculoc
    ports:
      - "5432:5432"
    volumes:
      - doculoc_postgres_data:/var/lib/postgresql/data

volumes:
  doculoc_postgres_data:
```

Suba o banco:

```bash
docker compose up -d
```

Pare o banco:

```bash
docker compose down
```

Remova o volume local:

```bash
docker compose down -v
```

---

## Prisma

### Gerar Prisma Client

```bash
npm run prisma:generate
```

### Criar/aplicar migration em desenvolvimento

```bash
npm run prisma:migrate
```

### Aplicar migrations em produção

```bash
npm run prisma:deploy
```

### Abrir Prisma Studio

```bash
npm run prisma:studio
```

### Resetar banco local

```bash
npm run prisma:reset
```

> Cuidado: `prisma:reset` apaga os dados do banco.

---

## Cloudflare R2 / S3-compatible storage

A API suporta três drivers:

```txt
local
r2
s3
```

### Desenvolvimento local

```env
STORAGE_DRIVER=local
CONTRACT_OUTPUT_DIR=storage/contracts
```

Nesse modo, os contratos são gravados no filesystem local.

### Produção com Cloudflare R2

Configure:

```env
STORAGE_DRIVER=r2
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=doculoc-contracts-prod
S3_ACCESS_KEY_ID=<access_key_id>
S3_SECRET_ACCESS_KEY=<secret_access_key>
```

### Fluxo de contrato com R2

```txt
Admin gera contrato
  ↓
ContractService renderiza DOCX em memória
  ↓
StorageService envia o buffer para R2
  ↓
Contract salva storageDriver/storageBucket/storageKey
  ↓
Download busca o arquivo no R2 e transmite o DOCX ao cliente
```

### Download

O endpoint de download retorna o arquivo `.docx` diretamente:

```http
GET /contracts/:id/download
```

Headers esperados:

```http
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
Content-Disposition: attachment; filename="contrato-doculoc.docx"
```

---

## Autenticação

A API usa JWT.

Após login, envie o token no header:

```http
Authorization: Bearer TOKEN
```

Rotas protegidas exigem usuário autenticado e, em alguns casos, role específica.

---

## Rotas

Base local:

```txt
http://localhost:3333
```

---

# Auth

## Criar usuário

```http
POST /auth/register
```

### Criar ADMIN

```json
{
  "name": "Admin Doculoc",
  "email": "admin@doculoc.com.br",
  "password": "12345678",
  "role": "ADMIN"
}
```

### Criar REAL_ESTATE

```json
{
  "email": "imobiliaria@doculoc.com.br",
  "password": "12345678",
  "role": "REAL_ESTATE",
  "realEstateProfile": {
    "name": "Imobiliária Exemplo",
    "cnpj": "12345678000199",
    "phone": "11999999999",
    "responsibleName": "Responsável Exemplo"
  }
}
```

Observações:

- `REAL_ESTATE` precisa enviar `realEstateProfile`.
- Ao criar `REAL_ESTATE`, a API cria wallet com 3 créditos.
- `cnpj` pode ser omitido ou enviado como string vazia.

---

## Login

```http
POST /auth/login
```

```json
{
  "email": "imobiliaria@doculoc.com.br",
  "password": "12345678"
}
```

Resposta:

```json
{
  "token": "jwt",
  "user": {
    "id": "uuid",
    "name": "Responsável Exemplo",
    "email": "imobiliaria@doculoc.com.br",
    "role": "REAL_ESTATE",
    "realEstateProfile": {}
  }
}
```

---

## Solicitar recuperação de senha

```http
POST /auth/forgot-password
```

```json
{
  "email": "usuario@doculoc.com.br"
}
```

Resposta genérica:

```json
{
  "message": "Se um usuário com esse email existir, um link para resetar a senha será enviado."
}
```

---

## Redefinir senha

```http
POST /auth/reset-password
```

```json
{
  "token": "token_recebido_no_email",
  "password": "novaSenha123",
  "passwordConfirmation": "novaSenha123"
}
```

---

# Rental Applications

Todas as rotas abaixo exigem autenticação.

## Criar consulta PF

Role: `REAL_ESTATE`

```http
POST /rental-applications/cpf
Authorization: Bearer TOKEN
```

```json
{
  "cpf": "12345678909",
  "email": "locatario@email.com",
  "phone": "11999999999",
  "rentValue": 1200,
  "condominiumValue": 300,
  "feesValue": 100
}
```

Campos:

- `cpf`: 11 dígitos, sem pontos ou traços.
- `rentValue`: aluguel.
- `condominiumValue`: condomínio.
- `feesValue`: outras taxas.

---

## Criar consulta PJ

Role: `REAL_ESTATE`

```http
POST /rental-applications/cnpj
Authorization: Bearer TOKEN
```

```json
{
  "cnpj": "12345678000199",
  "rentValue": 2500,
  "condominiumValue": 500,
  "feesValue": 200
}
```

Campos:

- `cnpj`: 14 dígitos, sem pontos ou traços.

---

## Listar consultas

Role: `ADMIN` ou `REAL_ESTATE`

```http
GET /rental-applications?page=1&perPage=25
```

Filtros opcionais:

```txt
requesterId
status
document
page
perPage
```

Exemplo:

```http
GET /rental-applications?status=WAITING_ADMIN_CONTRACT&page=1&perPage=10
```

Regra:

- `ADMIN` lista todas.
- `REAL_ESTATE` lista apenas suas próprias consultas.

---

## Detalhar consulta

Role: `ADMIN` ou `REAL_ESTATE`

```http
GET /rental-applications/:id
```

---

## Editar valores locatícios antes do contrato

Role: `ADMIN`

Permite que o usuário administrador ajuste os valores de aluguel, condomínio e IPTU antes da geração do contrato.

```http
PATCH /rental-applications/:id/rental-values
Authorization: Bearer TOKEN_ADMIN
```

```json
{
  "rentValue": 2800,
  "condominiumValue": 450,
  "feesValue": 180
}
```

Permitido quando a consulta está em:

```txt
WAITING_ADMIN_CONTRACT
```

---

## Preencher dados para contrato

Role: `REAL_ESTATE`

```http
PATCH /rental-applications/:id/contract-data
```

```json
{
  "tenantName": "Fulano da Silva",
  "tenantDocument": "12345678909",
  "tenantEmail": "fulano@email.com",
  "tenantPhone": "11999999999",
  "propertyZipCode": "01001000",
  "propertyStreet": "Praça da Sé",
  "propertyNumber": "100",
  "propertyComplement": "Apto 12",
  "propertyNeighborhood": "Sé",
  "propertyCity": "São Paulo",
  "propertyState": "SP"
}
```

Permitido quando a consulta está em:

```txt
WAITING_CONTRACT_DATA
```

Após preenchimento, o backend recalcula:

```txt
requestedExpense = rentValue + condominiumValue + feesValue
```

---

## Contestar consulta

Role: `REAL_ESTATE`

```http
POST /rental-applications/:id/contest
```

```json
{
  "reason": "Cliente apresentou documentação complementar e comprovante de renda atualizado."
}
```

Permitido quando a consulta está em:

```txt
REJECTED
```

Após contestação, o status muda para:

```txt
CONTESTED
```

---

## Decisão manual do admin

Role: `ADMIN`

```http
PATCH /rental-applications/:id/admin-decision
```

Aprovar:

```json
{
  "decision": "APPROVED",
  "reason": "Aprovado manualmente após análise documental."
}
```

Reprovar:

```json
{
  "decision": "REJECTED",
  "reason": "Documentação complementar insuficiente."
}
```

Se aprovado, a consulta volta para:

```txt
WAITING_CONTRACT_DATA
```

Se reprovado, a consulta vai para:

```txt
ADMIN_REJECTED
```

---

# Contracts

## Gerar contrato

Role: `ADMIN`

```http
POST /contracts/applications/:applicationId/generate
Authorization: Bearer TOKEN_ADMIN
```

A consulta precisa estar em:

```txt
WAITING_ADMIN_CONTRACT
```

Resposta:

```json
{
  "contract": {
    "id": "uuid",
    "applicationId": "uuid",
    "status": "GENERATED",
    "fileName": "contrato-uuid.docx",
    "storageDriver": "local | r2 | s3",
    "storageKey": "..."
  }
}
```

---

## Baixar contrato

Role: `ADMIN` ou `REAL_ESTATE` dona da consulta

```http
GET /contracts/:id/download
```

Retorna o arquivo `.docx` diretamente.

---

# Credits

Rotas exclusivas para `ADMIN`.

## Consultar carteira

```http
GET /credits/users/:userId/wallet
```

---

## Definir créditos

```http
PATCH /credits/users/:userId/credits
```

```json
{
  "credits": 10,
  "reason": "Créditos adicionados manualmente pelo admin."
}
```

---

## Ativar/desativar VIP

```http
PATCH /credits/users/:userId/vip
```

```json
{
  "isVip": true,
  "reason": "Cliente estratégico."
}
```

---

## Histórico de créditos

```http
GET /credits/users/:userId/ledger
```

---

# System

Rotas protegidas.

## Health check da Órago

```http
GET /system/health-check
```

## Produtos disponíveis na Órago

```http
GET /system/available-products
```

---

## Deploy no Render

### Backend Web Service

Configuração sugerida:

```txt
Runtime: Node
Branch: main
Build Command: npm ci --include=dev && npm run prisma:generate && npm run build
Pre-Deploy Command: npm run prisma:deploy
Start Command: npm run start
Health Check Path: /health
```

### Variáveis de produção no Render

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3333

DATABASE_URL=<Internal Database URL do Render Postgres>

JWT_SECRET=<segredo_forte>

ORAGO_BASE_URL=<url_producao_orago>
ORAGO_API_TOKEN=<token_producao_orago>

CONTRACT_TEMPLATE_PATH=src/templates/default-rental-application-contract.docx

STORAGE_DRIVER=r2
CONTRACT_OUTPUT_DIR=storage/contracts

S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=doculoc-contracts-prod
S3_ACCESS_KEY_ID=<access_key_id>
S3_SECRET_ACCESS_KEY=<secret_access_key>

CORS_ORIGIN=https://seu-frontend.com.br
APP_URL=https://seu-frontend.com.br

RESEND_API_KEY=<resend_api_key>
MAIL_FROM="Doculoc <noreply@seudominio.com.br>"
PASSWORD_RESET_TOKEN_EXPIRES_MINUTES=60

NPM_CONFIG_PRODUCTION=false
```

### Banco PostgreSQL no Render

1. Crie um serviço PostgreSQL no Render.
2. Copie a `Internal Database URL`.
3. Cole em `DATABASE_URL` no Web Service.
4. Garanta que `npm run prisma:deploy` esteja no Pre-Deploy Command.

### Cloudflare R2

1. Crie um bucket, por exemplo `doculoc-contracts-prod`.
2. Crie um R2 API Token com permissão de leitura e escrita no bucket.
3. Copie `Access Key ID` e `Secret Access Key`.
4. Copie o endpoint no formato:

```txt
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

5. Configure as variáveis `S3_*` no Render.

---

## Troubleshooting

### Build falha no Render por falta de tipos TypeScript

Erro comum:

```txt
Could not find a declaration file for module 'express'
Cannot find name 'Buffer'
Cannot find module 'node:fs'
```

Correção:

```txt
Build Command:
npm ci --include=dev && npm run prisma:generate && npm run build
```

E adicione no Render:

```env
NPM_CONFIG_PRODUCTION=false
```

---

### Arquivo DOCX baixa mas não abre

Possíveis causas:

1. Frontend salvou JSON como `.docx`.
2. Backend retornou URL assinada em vez do binário do arquivo.
3. `Content-Type` incorreto.
4. Template `.docx` corrompido.

O endpoint atual deve retornar o binário real do DOCX com:

```http
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
Content-Disposition: attachment; filename="contrato-doculoc.docx"
```

Um `.docx` válido é internamente um arquivo ZIP. Se renomear para `.zip`, deve conter:

```txt
[Content_Types].xml
word/document.xml
word/_rels/document.xml.rels
```

---

### Erro `S3 client não configurado`

Verifique se:

```env
STORAGE_DRIVER=r2
S3_ENDPOINT=...
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

estão definidos corretamente.

---

### Erro de CORS no frontend

Confirme:

```env
CORS_ORIGIN=https://seu-frontend.com.br
```

Em desenvolvimento:

```env
CORS_ORIGIN=http://localhost:5173
```

---

### Reset de senha não envia e-mail

Confirme:

```env
RESEND_API_KEY=...
MAIL_FROM="Doculoc <noreply@seudominio.com.br>"
APP_URL=https://seu-frontend.com.br
```

---

## Boas práticas de segurança

- Nunca versionar `.env`.
- Não commitar `prisma/dev.db`.
- Não commitar contratos gerados.
- Usar bucket privado no R2.
- Não tornar contratos públicos.
- Usar URLs/streams autenticados pelo backend para download.
- Usar `JWT_SECRET` forte em produção.
- Usar `HOST=0.0.0.0` no Render.
- Usar `CORS_ORIGIN` restrito ao domínio real do frontend.
- Rotacionar tokens expostos acidentalmente.
- Tratar respostas da Órago como dados sensíveis.
- Limitar logs com CPF/CNPJ, dados financeiros e dados pessoais.
- Implementar política de retenção para contratos e respostas brutas da Órago.

---

## Observações de LGPD

Este sistema trata dados pessoais e potencialmente sensíveis, incluindo:

- CPF/CNPJ
- Nome
- Telefone
- E-mail
- Endereço do imóvel
- Análise de crédito
- Resposta bruta de API externa
- Contratos de garantia locatícia

Recomendações:

- Armazenar apenas o necessário.
- Controlar acesso por perfil.
- Auditar ações administrativas.
- Evitar logs com dados pessoais.
- Definir prazo de retenção de documentos.
- Garantir que contratos sejam privados.

---

## Checklist rápido de produção

```txt
[ ] Banco PostgreSQL criado
[ ] DATABASE_URL configurada
[ ] Migrations aplicadas com prisma migrate deploy
[ ] STORAGE_DRIVER=r2
[ ] Bucket R2 criado
[ ] Token R2 com leitura/escrita criado
[ ] S3_ENDPOINT configurado
[ ] S3_BUCKET configurado
[ ] S3_ACCESS_KEY_ID configurado
[ ] S3_SECRET_ACCESS_KEY configurado
[ ] JWT_SECRET forte configurado
[ ] ORAGO_API_TOKEN de produção configurado
[ ] CORS_ORIGIN com domínio real
[ ] APP_URL com domínio real do frontend
[ ] RESEND_API_KEY configurado
[ ] MAIL_FROM configurado
[ ] Build passando no Render
[ ] Geração de contrato testada
[ ] Download de contrato testado
[ ] Reset de senha testado
```
