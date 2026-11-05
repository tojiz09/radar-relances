"""Assemble l'application en un seul fichier index.html (à la racine du dépôt).

Usage : python app/build.py
Entrées : app/ui.html (interface), app/core.js (moteur), data/demo_ibm.csv (jeu de démonstration)
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ui = (ROOT / 'app' / 'ui.html').read_text(encoding='utf-8')
core = (ROOT / 'app' / 'core.js').read_text(encoding='utf-8')
demo = (ROOT / 'data' / 'demo_ibm.csv').read_text(encoding='utf-8').strip()
assert '</script' not in core and '<' not in demo

head, body = ui.split('</style>', 1)
page = f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>body{{margin:0;font-size:14px}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{head}</style>
</head>
<body>
{body.replace('@@DEMO@@', demo).replace('@@CORE@@', core)}
</body>
</html>
"""
(ROOT / 'index.html').write_text(page, encoding='utf-8')
print(f'index.html généré ({len(page) // 1024} Ko)')
