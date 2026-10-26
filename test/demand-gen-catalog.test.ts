import {test,expect} from "bun:test";
import google from "../src/apps/google-ads.json";
test("Demand Gen can use atomic native operations and provider validation without schema loss",()=>{
 const tool=google.tools.find(t=>t.name==="bulk_mutate")!;
 expect(tool.path).toBe("/customers/{customer_id}/googleAds:mutate");
 expect(tool.input_schema.properties).toHaveProperty("validateOnly");
 expect(tool.input_schema.properties).toHaveProperty("responseContentType");
 expect(tool.input_schema.properties.mutateOperations.items).toEqual({type:"object"});
 for(const name of ["search","asset_mutate","ad_mutate","ad_group_criterion_mutate"]){expect(google.tools.some(t=>t.name===name)).toBe(true)}
});
