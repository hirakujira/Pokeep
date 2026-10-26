import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "pokekeep-mcp-data-"));
(globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ = data;
const store = await import("../src/lib/store");

test("MCP stdio 只執行一次呼叫並保留不確定錯誤", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pokekeep-pua-mock-"));
  fs.mkdirSync(path.join(root, "server"));
  fs.writeFileSync(path.join(root, "server", "iphone_use.py"), `import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    if request['method']=='initialize':
        result={'protocolVersion':'2025-06-18','capabilities':{},'serverInfo':{'name':'mock','version':'1'}}
    else:
        name=request['params']['name']
        if name=='pua_setup': data={'ok':True,'configured':False}
        else: data={'error':{'code':'action_uncertain','message':'not safe to retry','uncertain':True}}
        result={'content':[{'type':'text','text':json.dumps(data)}],'isError':'error' in data}
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
`);
  const { saveRuntimeConfig } = await import("../src/lib/runtime-config");
  saveRuntimeConfig({ iphoneUseRoot: root });
  const { IphoneMcp } = await import("../src/lib/iphone-mcp");
  const phone = new IphoneMcp();
  try {
    const status = await phone.call("setup", { action: "status" });
    assert.equal(status.configured, false);
    await assert.rejects(
      phone.call("tap", { x: 1, y: 2 }),
      (error: Error & { code?: string; uncertain?: boolean }) =>
        error.code === "action_uncertain" && error.uncertain === true,
    );
  } finally {
    phone.close();
    store.remove("settings", "runtime-config");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
after(() => {
  store.db().close();
  fs.rmSync(data, { recursive: true, force: true });
});
