import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OWNER, dashboardNginx } from './nginx.mjs';
const SITE = '/etc/nginx/conf.d/turnstate-console.conf';
const valid = domain => /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(domain);
function putSite(content) {
  const old = fs.existsSync(SITE) ? fs.readFileSync(SITE, 'utf8') : null;
  if (old && !old.startsWith(OWNER)) throw new Error('Refusing to replace unmanaged console site.');
  const tmp = SITE + '.tmp';
  fs.writeFileSync(tmp, content, { mode: 0o644 }); fs.renameSync(tmp, SITE);
  try { execFileSync('/usr/sbin/nginx', ['-t'], { stdio: 'pipe' }); execFileSync('/usr/bin/systemctl', ['reload','nginx'], { stdio: 'pipe' }); }
  catch (e) {
    if (old === null) fs.unlinkSync(SITE); else fs.writeFileSync(SITE, old, { mode: 0o644 });
    throw new Error('Console configuration rejected; previous file restored. ' + e.message);
  }
}
export function domainSetup(domain, config, issueCertificate = false) {
  if (!valid(domain) || config.adminOrigin !== `https://${domain}`) throw new Error('Domain must match the configured HTTPS adminOrigin.');
  const cert = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const key = `/etc/letsencrypt/live/${domain}/privkey.pem`;
  fs.mkdirSync('/var/www/letsencrypt/.well-known/acme-challenge', { recursive: true, mode: 0o755 });
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    putSite(`${OWNER}\n# Pending DNS/certificate; never expose the login over plaintext.\nserver {\n    listen 80;\n    server_name ${domain};\n    location ^~ /.well-known/acme-challenge/ {\n        root /var/www/letsencrypt;\n        default_type text/plain;\n        try_files $uri =404;\n    }\n    location / {\n        default_type text/plain;\n        return 503 "Turn-State console is installed. HTTPS activation is pending DNS and certificate.\\n";\n    }\n}\n`);
    if (!issueCertificate) return { domain, https: false, pending: 'DNS / certificate', command: `sudo turnstate domain-enable --domain ${domain} --apply` };
    execFileSync('/usr/bin/certbot', ['certonly','--webroot','--webroot-path','/var/www/letsencrypt','--non-interactive','--agree-tos','--keep-until-expiring','--cert-name',domain,'-d',domain], { stdio: 'pipe', timeout: 120000 });
  }
  // Require the certificate to actually cover this hostname before exposing login.
  execFileSync('/usr/bin/openssl', ['x509','-in',cert,'-noout','-checkhost',domain], { stdio: 'pipe' });
  putSite(dashboardNginx(domain, config.adminPort));
  fs.mkdirSync('/etc/letsencrypt/renewal-hooks/deploy', { recursive: true });
  const hook = '/etc/letsencrypt/renewal-hooks/deploy/turnstate-nginx-reload';
  if (!fs.existsSync(hook)) fs.writeFileSync(hook, '#!/bin/sh\n# Managed by sub2api-turnstate-extension\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n', { mode: 0o755 });
  return { domain, https: true, origin: config.adminOrigin };
}
