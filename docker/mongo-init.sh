#!/usr/bin/env bash
set -euo pipefail

echo "[mongo-init] waiting for mongo to accept connections..."
until mongosh --host mongo:27017 --quiet --eval "db.adminCommand('ping').ok" >/dev/null 2>&1; do
  sleep 1
done

echo "[mongo-init] ensuring replica set rs0 is initiated..."
mongosh --host mongo:27017 --quiet --eval '
try {
  const st = rs.status();
  if (st.ok === 1) {
    print("[mongo-init] rs0 already initiated");
    quit(0);
  }
} catch (e) {
  // not initiated
}

rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]});

for (let i = 0; i < 60; i++) {
  try {
    const st = rs.status();
    if (st.ok === 1) {
      print("[mongo-init] rs0 initiated");
      quit(0);
    }
  } catch (e) {}
  sleep(1000);
}

print("[mongo-init] rs0 did not become ready in time");
quit(1);
'
