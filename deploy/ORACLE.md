# Deploy the TrapStrike server on Oracle Cloud (Always Free) — $0, always-on

Goal: a permanent `wss://trapstrike.ogtraplord.com` your friends connect to.

Split of work: **you** do the Oracle signup + create the VM (interactive, needs your
account). **I** do DNS + install + TLS + deploy + run-as-a-service once you hand me the
VM's public IP and SSH access.

---

## YOUR PART (Oracle console, ~10–15 min)

### 1. Sign up
- https://www.oracle.com/cloud/free/ → "Start for free". Needs an email + a card for
  identity verification (not charged for Always Free resources). Pick a home region
  close to you and your friends (e.g. US East/West, or EU).

### 2. Create an Always Free VM
- Console → **Compute → Instances → Create instance**.
- **Image:** Canonical **Ubuntu 22.04** (or 24.04).
- **Shape:** click "Change shape" → **Ampere (Arm)** → `VM.Standard.A1.Flex`,
  1 OCPU / 6 GB (Always Free eligible — labelled "Always Free"). If Ampere is
  capacity-blocked in your region, the **AMD `VM.Standard.E2.1.Micro`** (1 GB) Always
  Free shape also works for our small server.
- **SSH keys:** choose **Save private key** (download it) — or paste an existing public
  key. Keep the private key safe; you'll point me at it.
- Create. Note the **Public IPv4 address** once it boots.

### 3. Open ports 80 + 443 (cloud firewall)
- On the instance page → **Subnet** → its **Security List** → **Add Ingress Rules**:
  - Source `0.0.0.0/0`, IP Protocol **TCP**, Destination port **80**
  - Source `0.0.0.0/0`, IP Protocol **TCP**, Destination port **443**
- (My setup script also opens the VM's internal iptables — Oracle needs both.)

### 4. Hand me three things
- the **public IP**
- the **path to the SSH private key** you downloaded (e.g. `~/Downloads/ssh-key.key`)
  and the **login user** (Ubuntu images = `ubuntu`)
- confirm you're OK with me using `trapstrike.ogtraplord.com` as the subdomain

That's it — then I take over.

---

## MY PART (once I have the IP + key)

1. **DNS** — add `trapstrike.ogtraplord.com` → your VM IP (A record, via your Hostinger
   DNS). Wait for it to resolve.
2. **Ship the code** — tar the backend (no node_modules) and `scp` it to `/opt/trapstrike`.
3. **Run setup** — `sudo DOMAIN=trapstrike.ogtraplord.com bash oracle-setup.sh`
   (installs Node + Caddy, opens iptables, starts the server as a service, Caddy gets a
   Let's Encrypt cert → `wss://` live).
4. **Verify** — connect a test client to `wss://trapstrike.ogtraplord.com` and confirm
   welcome + snapshots.

Then you deploy the game to ogtraplord.com and share:
`https://ogtraplord.com/project/trapstrike/?net=auth&server=wss://trapstrike.ogtraplord.com`

---

### Quicker stepping-stone (optional, no TLS)
If you just want to test with a friend who can run the game locally (`npm run dev`),
skip Caddy/DNS: open TCP **8080** in the Security List, run the server bound to
`0.0.0.0:8080`, and connect with `?net=auth&server=ws://<VM-IP>:8080` from each
`http://localhost` page. (Plain `ws://` is fine from an http page — only https pages
require `wss://`.)
