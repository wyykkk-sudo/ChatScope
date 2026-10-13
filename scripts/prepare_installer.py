from pathlib import Path
import json, zipfile, hashlib
from PIL import Image, ImageDraw
root=Path(__file__).resolve().parent
outputs=root.parent/'outputs'
payload=root/'installer-payload'
with zipfile.ZipFile(outputs/'ChatScope-Windows-x64.zip') as z:
    assert not any(n.startswith('ChatScope/data/') for n in z.namelist())
    assert all(not ('..' in Path(n).parts) for n in z.namelist())
    z.extractall(payload)
app=payload/'ChatScope'
assert not (app/'data').exists()
img=Image.new('RGBA',(256,256),(0,0,0,0))
d=ImageDraw.Draw(img)
d.rounded_rectangle((8,8,248,248),radius=58,fill='#193a2f')
d.rounded_rectangle((39,39,217,217),radius=45,fill='#d9ebae')
d.ellipse((62,62,194,194),outline='#193a2f',width=7)
d.ellipse((79,79,177,177),fill='#193a2f')
d.ellipse((139,86,164,111),fill='#d9ebae')
img.save(app/'chatscope.ico',format='ICO',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Installer payload prepared from the verified release zip; no runtime data included.')
