import hashlib,json,sys,zipfile
from pathlib import Path
root=Path(sys.argv[2]).resolve()
archive=Path(sys.argv[3]).resolve()
files=sorted(p for p in root.rglob('*') if p.is_file())
if any(p.is_symlink() or any(x in ('node_modules','__pycache__','work') for x in p.relative_to(root).parts) or p.name in ('pairing-token.txt','server.pid') or p.suffix=='.dpapi' or p.name.endswith(('.stdout.log','.stderr.log')) for p in files):
    raise RuntimeError('源码目录包含不应交付的运行文件')
if sys.argv[1]=='create':
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for p in files:z.write(p,root.name+'/'+p.relative_to(root).as_posix())
with zipfile.ZipFile(archive) as z:
    names={root.name+'/'+p.relative_to(root).as_posix():p for p in files}
    assert set(z.namelist())==set(names),'ZIP文件清单不一致'
    for name,p in names.items():assert hashlib.sha256(z.read(name)).digest()==hashlib.sha256(p.read_bytes()).digest(),name
print(json.dumps({'zipFiles':len(files),'zipVerified':True}))
