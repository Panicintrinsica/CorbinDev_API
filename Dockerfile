FROM oven/bun:1.1.42-alpine AS base
WORKDIR /src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile


RUN mkdir -p /temp/prod
COPY package.json bun.lockb /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production


FROM base AS prerelease
COPY --from=install /temp/dev/node_modules ./node_modules
COPY package.json bun.lockb tsconfig.json ./
COPY src ./src

RUN bun build src/index.ts --outdir ./build --target=bun

FROM base AS release

COPY --from=prerelease /src/app/build/index.js .

WORKDIR /src/app

# Uploaded images live on the filesystem, not in Atlas. Mount a volume here or
# every image uploaded is lost the next time this container is replaced.
ENV MEDIA_DIR=/src/app/media
RUN mkdir -p /src/app/media && chown -R bun:bun /src/app
VOLUME ["/src/app/media"]

USER bun

EXPOSE 5250/tcp
ENTRYPOINT [ "bun", "index.js" ]
