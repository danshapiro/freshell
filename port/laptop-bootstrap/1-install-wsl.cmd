@echo off
echo === freshell port bootstrap, step 1: WSL2 + Ubuntu ===
echo This will install WSL2 and the Ubuntu distro. Approve the admin prompt.
echo A REBOOT is usually required afterward.
wsl --install -d Ubuntu
echo.
echo After the reboot: open "Ubuntu" from the Start menu, create your Linux user,
echo then inside Ubuntu run:
echo   bash /mnt/c/Users/Public/freshell-bootstrap/2-bootstrap-wsl.sh
pause
