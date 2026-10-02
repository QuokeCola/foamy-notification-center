import os,json,shutil,tempfile,subprocess,sys,time,signal
from pathlib import Path
if '--inside' not in sys.argv:
 raise SystemExit(subprocess.run(['dbus-run-session','--','python3',__file__,'--inside',*sys.argv[1:]],timeout=25).returncode)
custom='--custom' in sys.argv
base=Path(tempfile.mkdtemp(prefix='foamy-stock-review-'));app=base/'app';app.mkdir();home=base/'home';home.mkdir();runtime=base/'runtime';runtime.mkdir(mode=0o700)
for n in ['Commons','Ui']:(app/n).symlink_to('/usr/share/omarchy/shell/'+n,target_is_directory=True)
shutil.copytree('/usr/share/omarchy/shell/plugins/notifications',app/'stock')
p=app/'stock/Service.qml';s=p.read_text();p.write_text(s[:s.rfind('  Variants {')]+'}\n')
shutil.copytree(Path(__file__).resolve().parents[1],app/'center',ignore=shutil.ignore_patterns('.git'))
(app/'shell.qml').write_text('''import QtQuick
import Quickshell
import Quickshell.Io
import "stock" as Stock
import "center" as Center
ShellRoot {Stock.Service {id:stock} Center.Service {id:center}
 IpcHandler {target:"review";function mark():void{center.markSeen()} function toggle():void{center.toggleDnd()} }
}''')
bin=base/'bin';bin.mkdir();cli=bin/'omarchy-shell';cli.write_text('#!/bin/sh\nexec qs ipc -n -p '+str(app)+' call "$@"\n');cli.chmod(0o755)
state=base/'custom-state' if custom else home/'.local/state'
env=dict(os.environ,HOME=str(home),XDG_CONFIG_HOME=str(home/'.config'),XDG_STATE_HOME=str(state),XDG_RUNTIME_DIR=str(runtime),PATH=str(bin)+':'+os.environ['PATH'],QT_QPA_PLATFORM='offscreen',QT_QUICK_BACKEND='software',QT_QPA_PLATFORMTHEME='basic')
for k in ['DISPLAY','WAYLAND_DISPLAY','HYPRLAND_INSTANCE_SIGNATURE']:env.pop(k,None)
log=(base/'log').open('w');proc=subprocess.Popen(['qs','-p',str(app),'--no-color'],env=env,stdout=log,stderr=log,start_new_session=True)
def ipc(t,*args):return subprocess.check_output(['qs','ipc','-n','-p',str(app),'call',t,*args],env=env,text=True,timeout=3).strip()
def status():return json.loads(ipc('foamy.notification-center.test','state'))
def wait(fn):
 end=time.monotonic()+5
 while time.monotonic()<end:
  try:
   if fn():return
  except Exception:pass
  time.sleep(.1)
 raise AssertionError((base/'log').read_text())
def send(title,replace=None):return subprocess.check_output(['notify-send','-p','-a','Stock Review','-u','critical',*(['-r',replace] if replace else []),title,'Synthetic compatibility check'],env=env,text=True,timeout=3).strip()
try:
 wait(lambda:ipc('notifications','ping')=='ok' and status()['loaded'])
 first=send('Stock before')
 wait(lambda:status()['newest']=='Stock before')
 send('Stock replaced',first);wait(lambda:status()['newest']=='Stock replaced');assert status()['entries']==1
 ipc('notifications','dismissAll');time.sleep(.3);assert status()['entries']==1
 ipc('notifications','toggleDnd');wait(lambda:status()['doNotDisturb'])
 ipc('notifications','toggleDnd');wait(lambda:not status()['doNotDisturb'])
 ipc('review','mark');wait(lambda:status()['unread']==0)
 ipc('review','toggle');wait(lambda:status()['doNotDisturb']);assert ipc('notifications','dndState')=='on'
 send('Stock silenced');wait(lambda:status()['entries']==2)
 ipc('review','toggle');wait(lambda:not status()['doNotDisturb'])
 ipc('foamy.notification-center.test','clear');wait(lambda:status()['entries']==0)
 send('After clear');wait(lambda:status()['entries']==1)
 print('PASS stock: delivery, in-place replacement, dismissal history, read state, DND both ways, silenced history, clear and subsequent arrival; Foamy Notifications absent')
finally:
 os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=3);log.close();print('Evidence:',base)
