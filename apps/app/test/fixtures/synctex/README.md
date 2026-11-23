This two-page fixture was generated with XeLaTeX (TeX Live 2025). Both included
sources are named `one.tex` to exercise project-relative path resolution.
The PDF and SyncTeX are checked in so browser tests do not require TeX or Docker.

To regenerate, copy the three sources into a temporary directory named
`texfolia-<suffix>/source`, preserving the folders, then run from `source`:

```sh
mkdir out
xelatex -interaction=nonstopmode -halt-on-error -synctex=1 -output-directory=out ./main.tex
```

Copy `out/main.pdf` here and decompress `out/main.synctex.gz` to `main.synctex`.
The temporary path matches the compiler's working directory layout.

The native reference query for `appendices/one.tex`, line 2:

```sh
synctex view -i '2:1:<absolute source>/./appendices/one.tex' -o out/main.pdf
```

returns page 2, h=133.768372, v=191.609436, H=9.075951 PDF points.
The top of that box is v-H=182.533485. Unit tests compare these coordinates.
