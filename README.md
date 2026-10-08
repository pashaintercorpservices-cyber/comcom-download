# ComCom — Installer

**Current version: 0.2.2** (adds: delete staff accounts). Check after downloading: right-click the file → Properties → size **97,492,140 bytes**.

**[⬇ Download ComCom-Setup.exe](https://github.com/pashaintercorpservices-cyber/comcom-download/raw/main/ComCom-Setup.exe?v=0.2.2)** (Windows 10/11, about 98 MB)

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

Staff outside the office connect through a **ComCom Relay** on a small Linux server (VPS) that your company rents (about US$5/month, e.g. Hostinger KVM 1, Hetzner, DigitalOcean). The relay only passes encrypted traffic to the office host PC; it cannot read messages and stores nothing.

1. Rent the smallest **Ubuntu 22.04/24.04** VPS. Allow TCP **443** and **7443** in the provider's firewall (if it has one).
2. Log in to it (SSH or the provider's browser terminal) and run this one line:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/pashaintercorpservices-cyber/comcom-download/main/relay/install-relay.sh | sudo bash
   ```
3. It ends by printing a code starting with `comcom-relay:`. On the office host PC: **ComCom → Admin console → Remote access** → paste it → **Save**. Status turns **🟢 Connected**.
4. Each remote staff member: the admin uses **Reset password** (or adds them) and sends the details by WhatsApp/email — the message now includes a `comcom:` connection code. They paste it under **Working outside the office?** → **Connect**, sign in, choose a password, and scan the QR code with an authenticator app (Google/Microsoft Authenticator).
