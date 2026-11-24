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

# The Tectonic bundle has biblatex 3.17, which accepts only biber 2.17. Debian has
# another version. The patch keeps documents from running code through biber.
FROM debian:bookworm-slim AS biber
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl patch \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /biber
ARG BIBER_VERSION=2.17
ARG BIBER_SHA256=1ee7efdd8343e982046f2301c1b0dcf09e1f9a997ac86ed1018dcb41d04c9e88
RUN curl -fsSL -o /tmp/biber.tar.gz "https://github.com/plk/biber/archive/refs/tags/v${BIBER_VERSION}.tar.gz" \
    && echo "${BIBER_SHA256}  /tmp/biber.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/biber.tar.gz --strip-components=1
COPY apps/compiler/biber/untrusted.patch /tmp/untrusted.patch
RUN patch -p1 < /tmp/untrusted.patch

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fontconfig libgraphite2-3 libharfbuzz0b libicu72 libssl3 poppler-utils \
    perl libautovivification-perl libbusiness-isbn-perl libbusiness-ismn-perl libbusiness-issn-perl \
    libclass-accessor-perl libdata-compare-perl libdata-dump-perl libdata-uniqid-perl \
    libdatetime-calendar-julian-perl libdatetime-format-builder-perl libdatetime-perl libencode-eucjpascii-perl \
    libencode-eucjpms-perl libencode-hanextra-perl libencode-jis2k-perl libfile-slurper-perl libio-string-perl \
    libipc-run3-perl liblingua-translit-perl liblist-allutils-perl liblist-moreutils-perl liblog-log4perl-perl \
    libparse-recdescent-perl libregexp-common-perl libsort-key-perl libtext-bibtex-perl libtext-csv-perl \
    libtext-csv-xs-perl libtext-roman-perl libunicode-collate-perl libunicode-linebreak-perl liburi-perl \
    libxml-libxml-perl libxml-libxml-simple-perl libxml-writer-perl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=biber /biber/lib/ /usr/share/perl5/
COPY --from=biber /biber/bin/biber /usr/local/bin/biber
COPY --from=tectonic-build /usr/local/bin/tectonic /usr/local/bin/tectonic
RUN useradd --create-home --uid 10001 engine
ENV HOME=/home/engine XDG_CACHE_HOME=/home/engine/.cache TECTONIC_UNTRUSTED_MODE=1 HOST=0.0.0.0 PORT=8080
USER engine
WORKDIR /home/engine
# Each document leaves its packages and fonts in the bundle cache.
RUN --mount=type=bind,source=apps/compiler/warmup,target=/tmp/warmup \
    mkdir /tmp/warm && for document in /tmp/warmup/*.tex; do \
    tectonic --untrusted --outdir /tmp/warm "$document" || exit 1; \
    done && rm -rf /tmp/warm
COPY --from=build /latex-engine /usr/local/bin/latex-engine
USER root
RUN du -sx --block-size=1 / > /etc/texfolia-image-size
USER engine
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --start-interval=1s CMD ["latex-engine", "healthcheck"]
CMD ["latex-engine"]
