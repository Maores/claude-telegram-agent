#!/bin/bash
# R4 of the hardening rollout: the weaker turn user agentturn with a sealed root-owned home, its
# sudo rule, process cap, cron, at and ssh denials, the metadata egress rule, the closed main home
# and the recorded phone-inbox key. Before changing anything it records the main home's modes and
# the firewall's OUTPUT chain under /etc/telegram-agent, for rollback-r4.sh.
set -euo pipefail
REPO=/home/claudebot/claude-bot
REC=/etc/telegram-agent
if id agentturn >/dev/null 2>&1; then echo "REFUSED: user agentturn already exists"; exit 1; fi
[ -f "$REPO/.state-dir" ] || { echo "REFUSED: $REPO/.state-dir missing (R3 first)"; exit 1; }
test "$(grep -c ' phone-inbox$' /home/claudebot/.ssh/authorized_keys)" = 1 || { echo "FAILED: expected exactly one phone-inbox key line (nothing changed yet)"; exit 1; }
ssh_before=$(systemctl is-active ssh.service ssh.socket || true)
echo "ssh.service and ssh.socket before R4:"
echo "$ssh_before"
sudo install -d -m 0755 "$REC" || { echo "FAILED: create $REC"; exit 1; }
find /home/claudebot -maxdepth 1 ! -type l -printf '%m %p\0' | sudo tee "$REC/r4-home-modes" >/dev/null || { echo "FAILED: record the home modes"; exit 1; }
sudo iptables -S OUTPUT | sudo tee "$REC/r4-iptables-output-before" >/dev/null || { echo "FAILED: record the OUTPUT chain"; exit 1; }
echo "recorded $REC/r4-home-modes and $REC/r4-iptables-output-before"

sudo useradd --system --no-create-home --home-dir /home/agentturn --shell /bin/bash --user-group agentturn || { echo "FAILED: useradd agentturn"; exit 1; }
sudo usermod -aG agentdata agentturn || { echo "FAILED: add agentturn to agentdata"; exit 1; }
sudo install -d -o root -g root -m 0711 /home/agentturn || { echo "FAILED: create /home/agentturn"; exit 1; }
sudo install -o root -g root -m 0644 /etc/skel/.bashrc /etc/skel/.profile /etc/skel/.bash_logout /home/agentturn/ || { echo "FAILED: install the shell files"; exit 1; }
for d in .claude .config .cache .bun .local; do sudo install -d -o root -g root -m 0755 /home/agentturn/$d; done
for d in tmp dev; do sudo install -d -o agentturn -g agentturn -m 0700 /home/agentturn/$d; done
sudo install -d -o agentturn -g agentdata -m 2750 /home/agentturn/outbox || { echo "FAILED: create the outbox"; exit 1; }
sudo visudo -cf /home/claudebot/claude-bot/deploy/sudoers-agentturn || { echo "FAILED: the sudoers drop-in does not parse"; exit 1; }
sudo install -m 0440 /home/claudebot/claude-bot/deploy/sudoers-agentturn /etc/sudoers.d/telegram-agent-turn || { echo "FAILED: install the sudoers drop-in"; exit 1; }
sudo visudo -c || { echo "FAILED: sudoers does not parse with the drop-in; removing it"; sudo rm -f /etc/sudoers.d/telegram-agent-turn; exit 1; }
sudo install -m 0644 /home/claudebot/claude-bot/deploy/limits-agentturn.conf /etc/security/limits.d/agentturn.conf || { echo "FAILED: install the limits drop-in"; exit 1; }
for f in /etc/cron.allow /etc/at.allow; do
  if sudo test -e "$f"; then
    echo "$f exists: the matching .deny file is ignored"
    if sudo grep -qx agentturn "$f"; then echo "FAILED: $f names agentturn"; exit 1; fi
  else
    echo "$f absent: the matching .deny file applies"
  fi
done
for f in /etc/cron.deny /etc/at.deny; do sudo touch "$f"; if ! sudo grep -qx agentturn "$f"; then if [ -n "$(sudo tail -c1 "$f")" ]; then echo | sudo tee -a "$f" >/dev/null; fi; echo agentturn | sudo tee -a "$f" >/dev/null; fi; done
echo 'DenyUsers agentturn' | sudo tee /etc/ssh/sshd_config.d/50-agentturn.conf >/dev/null || { echo "FAILED: write the sshd drop-in"; exit 1; }
sudo sshd -t || { echo "FAILED: sshd -t; removing the sshd drop-in"; sudo rm -f /etc/ssh/sshd_config.d/50-agentturn.conf; exit 1; }
sudo systemctl reload ssh.service || sudo systemctl restart ssh.socket || { echo "FAILED: reload ssh"; exit 1; }
sudo install -m 0644 /home/claudebot/claude-bot/deploy/agentturn-egress.service /etc/systemd/system/ || { echo "FAILED: install the egress unit"; exit 1; }
sudo systemctl daemon-reload
sudo systemctl enable --now agentturn-egress.service || { echo "FAILED: start agentturn-egress"; exit 1; }
chmod 0711 /home/claudebot || { echo "FAILED: chmod the home"; exit 1; }
find /home/claudebot -maxdepth 1 -mindepth 1 ! -type l ! -name claude-bot ! -name .bun -exec chmod o-rwx {} + || { echo "FAILED: close the home's entries"; exit 1; }
chmod 0700 /home/claudebot/inbox /home/claudebot/rchannel /home/claudebot/cc-journal /home/claudebot/backups /home/claudebot/.claude /home/claudebot/.ssh || { echo "FAILED: chmod the private folders"; exit 1; }
test "$(grep -c ' phone-inbox$' /home/claudebot/.ssh/authorized_keys)" = 1 || { echo "FAILED: expected exactly one phone-inbox key line"; exit 1; }
grep ' phone-inbox$' /home/claudebot/.ssh/authorized_keys | tr -d '\n' | sha256sum | sudo install -D -m 0644 /dev/stdin /etc/telegram-agent/inbox-key.sha256 || { echo "FAILED: record the phone-inbox key hash"; exit 1; }

echo "ssh.service and ssh.socket after R4:"
systemctl is-active ssh.service ssh.socket || true
echo "R4 DONE (run proofs-r4.sh next)"
