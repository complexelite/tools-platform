# FFmpeg is built from the requested upstream source at an immutable commit.
FROM debian:bookworm-slim AS ffmpeg-build
ARG FFMPEG_COMMIT=aab6cec3e8415154b3f0570f8d131db07a9901de
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential nasm yasm pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init ffmpeg && cd ffmpeg && git remote add origin https://github.com/FFmpeg/FFmpeg.git && git fetch --depth 1 origin "$FFMPEG_COMMIT" && git checkout --detach FETCH_HEAD && ./configure --prefix=/opt/ffmpeg --disable-doc --disable-debug --disable-network --disable-shared --enable-static --disable-ffplay && make -j2 && make install

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 PATH="/opt/ffmpeg/bin:${PATH}" CHROME_BIN=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /opt/ffmpeg /opt/ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
