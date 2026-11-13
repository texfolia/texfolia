FROM golang:1.26.10-bookworm AS build
WORKDIR /build
COPY apps/compiler/engine/go.mod apps/compiler/engine/go.sum ./
RUN go mod download
COPY apps/compiler/engine/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /latex-engine .

FROM rust:1.79-bookworm AS tectonic-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    libfontconfig-dev libfreetype-dev libgraphite2-dev libharfbuzz-dev libicu-dev libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tectonic
ARG TECTONIC_COMMIT=0a8e2f52b895e2fd60cb461c1859b927a18e024d
RUN curl -fsSL "https://github.com/tectonic-typesetting/tectonic/archive/${TECTONIC_COMMIT}.tar.gz" \
    | tar -xz --strip-components=1
COPY apps/compiler/tectonic/bibtex_cache.rs src/bibtex_cache.rs
COPY apps/compiler/tectonic/driver.patch /tmp/driver.patch
RUN patch -p1 < /tmp/driver.patch
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/tectonic/target \
    cargo build --release --locked --features external-harfbuzz --bin tectonic \
    && cargo test --release --locked --features external-harfbuzz --lib driver::bibtex_cache::tests \
    && cp target/release/tectonic /usr/local/bin/tectonic

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fontconfig libgraphite2-3 libharfbuzz0b libicu72 libssl3 poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tectonic-build /usr/local/bin/tectonic /usr/local/bin/tectonic
RUN useradd --create-home --uid 10001 engine
ENV HOME=/home/engine XDG_CACHE_HOME=/home/engine/.cache TECTONIC_UNTRUSTED_MODE=1 HOST=0.0.0.0 PORT=8080
USER engine
WORKDIR /home/engine
RUN mkdir /tmp/warmup && for class in article report book amsart beamer; do \
    if [ "$class" = beamer ]; then body='\begin{frame}Ready\end{frame}'; else body=Ready; fi; \
    printf '\\documentclass{%s}\n\\begin{document}%s\\end{document}\n' "$class" "$body" > /tmp/warmup/main.tex; \
    tectonic --untrusted /tmp/warmup/main.tex || exit 1; \
    done && rm -rf /tmp/warmup
COPY --from=build /latex-engine /usr/local/bin/latex-engine
USER root
RUN du -sx --block-size=1 / > /etc/texfolia-image-size
USER engine
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --start-interval=1s CMD ["latex-engine", "healthcheck"]
CMD ["latex-engine"]
