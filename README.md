# ComCom — Installer

**Current version: 0.3.0** (adds: shared relay for remote staff of many companies; office address no longer shows Docker/WSL addresses). Check after downloading: right-click the file → Properties → size **97,495,950 bytes**.

**[⬇ Download ComCom-Setup.exe](https://github.com/pashaintercorpservices-cyber/comcom-download/raw/main/ComCom-Setup.exe?v=0.3.0)** (Windows 10/11, about 98 MB)

## Already have ComCom? Upgrading

Run the newly downloaded installer on the PC. Your company, users and messages are kept. **Upgrade the company host PC first.**

Tip: your browser may save repeat downloads as `ComCom-Setup (1).exe`, `(2)`… — run the **newest** one (check the size above).

## Install on a staff PC

1. Download and open **ComCom-Setup.exe**.
   If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**.
2. When asked **"How will this PC be used?"**, choose **Staff PC**, then **Install**.
3. ComCom finds your company on the office network automatically.
   Sign in with the **username and temporary password** your administrator gave you, then choose your own password.

Your PC must be connected to the office network the first time you set it up.

---
Version 0.2.2. SHA-256: `39a16e463f79d627b2cfff11066ac07f8a52b794cce3f7f0593f37972fd934d5`

## Staff working from another location (remote access)

Staff outside the office connect through a **ComCom Relay**: a small Linux server (VPS) that passes encrypted traffic to each company's office host PC. It cannot read messages and stores nothing.

**One relay serves many companies.** Run one relay and give each client company its own code; they don't need servers of their own. Companies can't see or reach each other. **Everyone (host and staff PCs) needs ComCom 0.3.0 or newer.**

### Set up the relay (once, about 10 minutes)
1. Rent the smallest **Ubuntu 24.04** VPS (e.g. Hostinger KVM 1). If the provider has a firewall setting, allow TCP **443** and **7443**.
2. Open its terminal (Hostinger: **Browser terminal**; or `ssh root@<VPS IP>` in PowerShell) and run, with your first company's name:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/pashaintercorpservices-cyber/comcom-download/main/relay/install-relay.sh | sudo bash -s -- "InterManagement"
   ```
3. It prints that company's code, starting with `comcom-relay:`, and checks that the company address works.

### Add a client company (each one gets its own code)
In the VPS terminal:
```bash
comcom-relay add "Client Company Name"
```
Other commands: `comcom-relay list`, `comcom-relay code <company>` (show a code again), `comcom-relay disable <company>` / `enable <company>` (e.g. unpaid subscription), `comcom-relay remove <company>`.

### In each company
1. On the office host PC: **ComCom → Admin console → Remote access** → paste the company's code → **Save**. Status turns **🟢 Connected**.
2. For each remote staff member, the admin uses **Reset password** (or adds them) and sends the details by WhatsApp/email. The message includes a `comcom:` connection code. The staff member pastes it under **Working outside the office?** → **Connect**, signs in, chooses a password and scans the QR code with an authenticator app (Google/Microsoft Authenticator).

Company addresses use the free sslip.io DNS service by default. To use your own domain instead, add a DNS record `*.relay.yourdomain.com` → VPS IP, and put `RELAY_DOMAIN=relay.yourdomain.com` before `bash` in the install line (re-running the installer keeps existing companies).
