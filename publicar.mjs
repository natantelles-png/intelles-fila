// Publica no Instagram o que estiver vencido em fila.json, pela API oficial da Meta.
// Sem dependências. Roda no GitHub Actions a cada 30 minutos.
// Variáveis: IG_USER_ID, IG_TOKEN, BASE_URL (endereço público da pasta midia/).
// Opcionais: DRY_RUN=1 (só mostra), GRAPH_HOST, GRAPH_VERSION, FILA, ESPERA_MS.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILA = process.env.FILA || fileURLToPath(new URL('./fila.json', import.meta.url));
const HOST = process.env.GRAPH_HOST || 'https://graph.instagram.com';
const VERSAO = process.env.GRAPH_VERSION || 'v24.0';
const { IG_USER_ID, IG_TOKEN, BASE_URL, DRY_RUN } = process.env;
const ESPERA_MS = Number(process.env.ESPERA_MS || 20000);
const TOLERANCIA_H = 12; // passou disso, o post não sai: conteúdo com data não vai ao ar dias depois
const MAX_TENTATIVAS = 3;

async function api(metodo, caminho, params = {}) {
  const url = new URL(`${HOST}/${VERSAO}/${caminho}`);
  const corpo = new URLSearchParams({ ...params, access_token: IG_TOKEN });
  const res = metodo === 'GET'
    ? await fetch(`${url}?${corpo}`)
    : await fetch(url, { method: 'POST', body: corpo });
  const json = await res.json().catch(() => ({}));
  // Só a mensagem da API: a URL e o corpo levam o token e nunca vão para o log.
  if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function aguardar(id) {
  for (let i = 0; i < 15; i++) {
    const { status_code: s } = await api('GET', id, { fields: 'status_code' });
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`Container ${s}`);
    await new Promise((r) => setTimeout(r, ESPERA_MS));
  }
  throw new Error('Container não ficou pronto a tempo');
}

async function publicar(item) {
  const urls = item.imagens.map((i) => `${BASE_URL.replace(/\/$/, '')}/${i}`);
  let criacao;
  if (urls.length === 1) {
    ({ id: criacao } = await api('POST', `${IG_USER_ID}/media`, { image_url: urls[0], caption: item.legenda }));
  } else {
    const filhos = [];
    for (const image_url of urls) {
      const { id } = await api('POST', `${IG_USER_ID}/media`, { image_url, is_carousel_item: 'true' });
      await aguardar(id);
      filhos.push(id);
    }
    ({ id: criacao } = await api('POST', `${IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: filhos.join(','), caption: item.legenda }));
  }
  await aguardar(criacao);
  const { id } = await api('POST', `${IG_USER_ID}/media_publish`, { creation_id: criacao });
  return id;
}

const salvar = (fila) => fs.writeFileSync(FILA, JSON.stringify(fila, null, 2) + '\n');
const fila = JSON.parse(fs.readFileSync(FILA, 'utf8'));
const agora = Date.now();
let falhou = false;

for (const item of fila) {
  if (item.status !== 'agendado' || new Date(item.quando).getTime() > agora) continue;
  if (agora - new Date(item.quando).getTime() > TOLERANCIA_H * 3600e3) {
    item.status = 'vencido';
    console.log(`VENCIDO ${item.id}: passou de ${TOLERANCIA_H}h, não publicado`);
    falhou = true;
    salvar(fila);
    continue;
  }
  if (DRY_RUN) { console.log(`DRY_RUN ${item.id}: ${item.imagens.length} imagem(ns)`); continue; }
  try {
    item.ig_id = await publicar(item);
    item.status = 'publicado';
    item.publicado_em = new Date().toISOString();
    console.log(`PUBLICADO ${item.id}: ${item.ig_id}`);
  } catch (e) {
    item.tentativas = (item.tentativas || 0) + 1;
    item.ultimo_erro = e.message;
    if (item.tentativas >= MAX_TENTATIVAS) item.status = 'erro';
    console.error(`ERRO ${item.id} (tentativa ${item.tentativas}): ${e.message}`);
    falhou = true;
  }
  salvar(fila); // grava item a item para não repetir post se o próximo falhar
}
if (falhou) process.exitCode = 1; // o GitHub avisa por e-mail quando o workflow falha
