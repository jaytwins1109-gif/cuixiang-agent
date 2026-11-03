' silent launcher for cuixiang dev server (no window, ASCII only)
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = here
ws.Run "cmd.exe /c """ & here & "\run-server.bat""", 0, False
