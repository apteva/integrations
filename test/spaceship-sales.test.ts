import {expect,test} from 'bun:test';
import app from '../src/apps/spaceship.json';
test('Spaceship exposes confirmed cursor-paginated sales separately from listing status',()=>{
 const sold=app.tools.find(t=>t.name==='list_sellerhub_sold_domains')!;
 expect(sold.method).toBe('GET');expect(sold.path).toBe('/v1/sellerhub/domains/reports/sold');
 expect(sold.input_schema.required).toEqual(['take']);expect(sold.input_schema.properties).toHaveProperty('cursor');expect(sold.input_schema.properties).toHaveProperty('saleDateTimeFrom');
 expect(app.tools.find(t=>t.name==='list_sellerhub_domains')!.input_schema.properties.status.enum).toContain('sold');
});
