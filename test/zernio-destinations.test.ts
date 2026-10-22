import {afterEach,expect,test} from "bun:test";
import {getAppTemplate} from "../src/apps/index.js";
import {executeTool} from "../src/http-executor.js";
import type {AppTemplate} from "../src/types.js";
const app=getAppTemplate("zernio") as AppTemplate;
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original});
test("connected board operations coexist with OAuth selection in one catalog",()=>{
 for(const name of ["list_pinterest_boards","select_pinterest_board","list_account_pinterest_boards","create_pinterest_board","set_default_pinterest_board"])expect(app.tools.some(t=>t.name===name)).toBe(true);
 expect(app.tools.find(t=>t.name==="list_pinterest_boards")!.path).toBe("/connect/pinterest/select-board");
});
test("board list/create/default operations use the account path with clean bodies",async()=>{
 for(const [name,method,input,expected] of [["list_account_pinterest_boards","GET",{accountId:"acc-1"},undefined],["create_pinterest_board","POST",{accountId:"acc-1",name:"Recipes",privacy:"SECRET"},{name:"Recipes",privacy:"SECRET"}],["set_default_pinterest_board","PUT",{accountId:"acc-1",defaultBoardId:"board-1"},{defaultBoardId:"board-1"}]] as const){
  let captured:{url:string;init:RequestInit}|undefined;
  globalThis.fetch=(async(url,init)=>{captured={url:String(url),init:init||{}};return Response.json({boards:[]})}) as typeof fetch;
  const tool=app.tools.find(t=>t.name===name)!;
  await executeTool({app,tool,input:{...input},credentials:{api_key:"test-key"}});
  expect(captured!.url).toBe("https://zernio.com/api/v1/accounts/acc-1/pinterest-boards");expect(captured!.init.method).toBe(method);
  if(expected)expect(JSON.parse(String(captured!.init.body))).toEqual(expected);else expect(captured!.init.body).toBeUndefined();
 }
});
