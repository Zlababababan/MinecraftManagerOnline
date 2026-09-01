# MinecraftManagerOnline — image du panel. La vraie réponse à Alpine/musl : l'image emporte sa
# libc (bookworm), le runtime vient de l'image de base — aucun runtime épinglé à embarquer.
#
#   docker build -t mmo-panel .           # construction locale (sans agents embarqués)
#   docker compose up -d                  # voir docker-compose.yml (volume nommé, port)
#
# L'image officielle (ghcr.io, publiée par release.yml) embarque en plus les archives d'agents
# dans /app/dist-agent (déposées dans docker/dist-agent/ avant le build) : le panel les publie
# au démarrage et sert les one-liners d'installation, comme depuis une archive classique.

FROM node:24-bookworm-slim AS build
WORKDIR /src
ENV CI=true
COPY . .
# corepack lit `packageManager` de package.json : même pnpm que la CI.
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build
# Arborescence de production auto-portante — mêmes flags que tools/release/build.mjs.
RUN pnpm --filter @mmo/panel deploy --prod --legacy --config.node-linker=hoisted /out/app \
  && cp -R apps/web/dist /out/web

FROM node:24-bookworm-slim
WORKDIR /app
# 0.0.0.0 est refusé partout ailleurs (doc 05 §12) ; en conteneur, la publication de port EST la
# couche d'accès — opt-in explicite, jamais déduit d'une détection de conteneur (Podman rootless).
ENV NODE_ENV=production \
  MMO_DATA_DIR=/data \
  MMO_WEB_DIR=/app/web \
  MMO_HOST=0.0.0.0 \
  MMO_ALLOW_ANY_INTERFACE=1 \
  MMO_PORT=3000
COPY --from=build /out/app /app/app
COPY --from=build /out/web /app/web
# Vide en build local ; release.yml y dépose les archives d'agents + manifeste avant le build.
COPY docker/dist-agent/ /app/dist-agent/
COPY docker/entrypoint.sh /app/entrypoint.sh
# /data appartient à `node` : un volume nommé en hérite à sa création — un bind ./data créé par
# root reproduirait exactement le SQLITE_CANTOPEN (docker-compose.yml recommande le volume nommé).
RUN chmod +x /app/entrypoint.sh && mkdir -p /data && chown node:node /data /app/dist-agent
USER node
VOLUME /data
EXPOSE 3000
# Sans curl : le runtime sait faire.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MMO_PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
