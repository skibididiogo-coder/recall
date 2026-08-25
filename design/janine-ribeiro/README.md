# Janine Ribeiro — Psicologia Infantil

Identidade e site para a prática privada de psicologia infantil de Janine Ribeiro
(Portugal). Desenhado como um canvas de vários artboards.

## Artboards

| Ficheiro | O que é |
| --- | --- |
| `Main.dc.html` | Página do site, desktop (1440 px) |
| `Mobile.dc.html` | A mesma página em telemóvel (390 × 844) |
| `Marca.dc.html` | Logótipo, símbolo, avatar, favicon e regras de aplicação |
| `Tipografia.dc.html` | Faustina + Figtree e a escala tipográfica |
| `Cores.dc.html` | Paleta principal, tons de apoio e notas de contraste |

`canvas.json` define a disposição dos artboards no canvas e as notas.

## Sistema

**Tipografia** — Faustina (títulos) e Figtree (texto e interface), ambas do Google
Fonts. Reservas: Georgia e Avenir Next / Segoe UI.

**Cores**

| Token | Hex | Uso |
| --- | --- | --- |
| Areia clara | `#FBF6EE` | Fundo principal |
| Areia | `#F4EBE0` | Secções alternadas |
| Café | `#362B23` | Títulos e texto |
| Terracota | `#A35C3A` | Botões e links (5,1:1 com branco) |
| Terracota clara | `#D08462` | Ilustração — nunca texto |
| Sálvia | `#6BAC74` | Confirmações |

Apoio: `#E8DCCD` linhas · `#FCE8E0` e `#DFF3E1` fundos suaves · `#72675D` texto
secundário · `#2A2119` rodapé.

Os acentos foram definidos em oklch com a mesma luminosidade e croma
(`oklch(0.685 0.105 h)`), variando só a matiz.

## Por preencher

Tudo o que aparece entre `[parênteses retos]` são dados reais em falta: morada,
telemóvel, email, número de cédula da Ordem dos Psicólogos, NIF, preços,
formação e escalão etário. A frase em itálico na secção «Sobre» é uma proposta
e deve ser aprovada ou substituída.

## Regenerar o canvas

O `.html` montado não é versionado. Para o reconstruir a partir destes ficheiros,
usar o helper da skill `design` (`seed-canvas.mjs`) com os cinco artboards e o
`canvas.json`.
