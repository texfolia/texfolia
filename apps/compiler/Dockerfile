FROM golang:1.26.10-bookworm AS build
WORKDIR /build
COPY apps/compiler/engine/go.mod ./
COPY apps/compiler/engine/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /latex-engine .

FROM debian:bookworm-slim AS runtime
ARG TECTONIC_VERSION=0.15.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fontconfig \
    && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin tectonic \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 engine
ENV HOME=/home/engine XDG_CACHE_HOME=/home/engine/.cache TECTONIC_UNTRUSTED_MODE=1 HOST=0.0.0.0 PORT=8080
USER engine
WORKDIR /home/engine
# Cache the base LaTeX format and packages before accepting work.
RUN mkdir /tmp/warmup && printf '\\documentclass{article}\n\\begin{document}Ready\\end{document}\n' > /tmp/warmup/main.tex \
    && tectonic --untrusted /tmp/warmup/main.tex && rm -rf /tmp/warmup
COPY --from=build /latex-engine /usr/local/bin/latex-engine
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --start-interval=1s CMD ["latex-engine", "healthcheck"]
CMD ["latex-engine"]
