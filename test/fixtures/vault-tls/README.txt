A self-signed certificate for 127.0.0.1, for the tests' own stand-in Vaultwarden only
(test/server/own-server-vault.test.ts): the board pins Vaultwarden's certificate on loopback.
Made with: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500
  -subj "/CN=agent-board test vaultwarden" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
Never used outside the tests.
other-cert.pem: another such certificate (its key thrown away), which the board must not trust for the stand-in.
