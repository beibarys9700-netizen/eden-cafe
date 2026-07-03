@echo off
cd /d C:\eden
git add -A
git commit -m "%1"
git push origin main
echo Done! Render will redeploy automatically.
