import {test,expect} from '@playwright/test';

test('demo shows simulated calls feed with priorities and read-only rows',async({page})=>{
 await page.goto('/');
 await expect(page.getByText('Simulated calls',{exact:true})).toBeVisible();
 await expect(page.getByText('MG Road',{exact:true})).toBeVisible();
 await expect(page.getByText('Awaiting assignment',{exact:true})).toBeVisible();
 await expect(page.getByText('Unit 01 en route',{exact:false})).toBeVisible();
 // P1 open call is marked on the map with a permanent tooltip.
 await expect(page.locator('.incident-tooltip').first()).toBeInViewport();
 // Demo is read-only: no assignment controls.
 await expect(page.getByRole('button',{name:'Assign',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'New call',exact:true})).toHaveCount(0);
 // Boston buses view has no calls panel.
 await page.getByLabel('Demo data source').selectOption('stand_in');
 await expect(page.getByText('Simulated calls',{exact:true})).toHaveCount(0);
});

test('dispatcher runs a call end to end: create, assign, advance status, close',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Dispatcher sign in'}).click();
 await page.getByLabel('Fleet ID').fill('test-fleet');
 await page.getByLabel('Password',{exact:true}).fill('mock-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.locator('.calls-panel h2')).toHaveText('Calls');
 await page.getByRole('button',{name:'New call',exact:true}).click();
 await page.getByLabel('Call label').fill('Test call Indiranagar');
 await page.getByLabel('Call latitude').fill('12.97');
 await page.getByLabel('Call longitude').fill('77.64');
 await page.getByLabel('Call priority').selectOption('1');
 await page.getByRole('button',{name:'Create call',exact:true}).click();
 const row=page.locator('.incident-row',{hasText:'Test call Indiranagar'});
 await expect(row).toBeVisible({timeout:7000});
 await expect(row.getByText('Awaiting assignment',{exact:true})).toBeVisible();
 await row.getByLabel('Assign vehicle for Test call Indiranagar').selectOption({label:'Unit 01'});
 await row.getByRole('button',{name:'Assign',exact:true}).click();
 await expect(row.getByText('Unit 01 en route',{exact:false})).toBeVisible({timeout:7000});
 // Advance the unit through the status workflow; the call mirrors it.
 await page.locator('.vehicle-row',{hasText:'Unit 01'}).first().click();
 await page.getByRole('button',{name:'at scene',exact:true}).click();
 await expect(row.getByText('Unit 01 on scene',{exact:false})).toBeVisible({timeout:7000});
 await row.getByRole('button',{name:'Close call',exact:true}).click();
 await expect(row.locator('.incident-status')).toHaveText('Closed',{timeout:7000});
 // Closing a call releases the unit: it can take the next call without manual status changes.
 await page.getByRole('button',{name:'New call',exact:true}).click();
 await page.getByLabel('Call label').fill('Second call');
 await page.getByLabel('Call latitude').fill('12.95');
 await page.getByLabel('Call longitude').fill('77.60');
 await page.getByRole('button',{name:'Create call',exact:true}).click();
 const second=page.locator('.incident-row',{hasText:'Second call'});
 await expect(second).toBeVisible({timeout:7000});
 await second.getByLabel('Assign vehicle for Second call').selectOption({label:'Unit 01'});
 await second.getByRole('button',{name:'Assign',exact:true}).click();
 await expect(second.getByText('Unit 01 en route',{exact:false})).toBeVisible({timeout:7000});
});

test('crew page shares device GPS as a vehicle and stops cleanly',async({context,page})=>{
 await context.grantPermissions(['geolocation']);
 await context.setGeolocation({latitude:12.9716,longitude:77.5946,accuracy:12});
 await page.goto('/crew');
 await page.getByLabel('Crew token').fill('mock.dispatcher.token');
 await page.getByLabel('Vehicle ID').fill('unit-1');
 await page.getByRole('button',{name:/Start sharing/}).click();
 await expect(page.getByText('Position accepted',{exact:false}).first()).toBeVisible({timeout:20000});
 await expect(page.getByText(/12 m accuracy/,{exact:false}).first()).toBeVisible();
 await page.getByRole('button',{name:/Stop sharing/}).click();
 await expect(page.getByText('Sharing stopped',{exact:false})).toBeVisible();
});
test('dispatcher issues a 15-minute crew link from the vehicle panel',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Dispatcher sign in'}).click();
 await page.getByLabel('Fleet ID').fill('test-fleet');
 await page.getByLabel('Password',{exact:true}).fill('mock-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.locator('.vehicle-row',{hasText:'Unit 01'}).first().click();
 await page.getByRole('button',{name:/Crew link/}).click();
 const linkInput=page.getByLabel('Crew link',{exact:true});
 await expect(linkInput).toBeVisible({timeout:7000});
 const href=await linkInput.inputValue();
 expect(href).toContain('/crew#token=mock.crew.token');
 expect(href).toContain('vehicle=unit-1');
 // The issued link prefills the crew page; the fragment carries the token.
 await page.goto(href.replace(/^https?:\/\/[^/]+/,''));
 await expect(page.getByLabel('Crew token')).toHaveValue('mock.crew.token');
 await expect(page.getByLabel('Vehicle ID')).toHaveValue('unit-1');
});
