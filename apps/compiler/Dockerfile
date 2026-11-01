FROM oven/bun:1.4.4-debian AS runtime
ARG TECTONIC_VERSION=0.15.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fontconfig \
    && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin tectonic \
    && rm -rf /var/lib/apt/lists/*
ENV XDG_CACHE_HOME=/home/bun/.cache TECTONIC_UNTRUSTED_MODE=1 PORT=8080
RUN mkdir -p /home/bun/.cache && chown -R bun:bun /home/bun/.cache
WORKDIR /app
COPY --chown=bun:bun src ./src
USER bun
# Cache the base LaTeX format and packages in the image, before accepting work.
RUN mkdir /tmp/warmup && printf '\\documentclass{article}\n\\begin{document}Ready\\end{document}\n' > /tmp/warmup/main.tex \
    && tectonic --untrusted /tmp/warmup/main.tex && rm -rf /tmp/warmup
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e 'if (!(await fetch("http://localhost:8080/health")).ok) process.exit(1)'
CMD ["bun", "run", "src/index.ts"]
