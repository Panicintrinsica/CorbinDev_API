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

RUN mkdir -p /src/app && chown bun:bun /src/app
USER bun

EXPOSE 5250/tcp
ENTRYPOINT [ "bun", "index.js" ]
