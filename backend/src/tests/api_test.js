const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

// Test locations
const LOCATIONS = {
    odenplan: { lat: 59.343298, lon:18.050608},
    stockholm_center: { lat: 59.3293, lon: 18.0686 },
    kth: { lat: 59.3498, lon: 18.0684 },
    odengatan: { lat: 59.344611, lon: 18.057730}
};

async function testAPI() {
    console.log('Testing GVI Routing API...\n');
    let passedTests = 0;
    let totalTests = 0;

    try {
        // 1. Health check
        totalTests++;
        console.log('1. Testing health check...');
        const health = await axios.get(`${BASE_URL}/api/v1/health`);
        console.log(`✓ Health: ${health.data.status}`);
        passedTests++;

        // 2. System status
        totalTests++;
        console.log('\n2. Testing system status...');
        const status = await axios.get(`${BASE_URL}/api/v1/status`);
        console.log(`✓ Service: ${status.data.service}`);
        console.log(`✓ Environment: ${status.data.environment}`);
        passedTests++;

        // 3. Available months
        totalTests++;
        console.log('\n3. Testing available months...');
        const months = await axios.get(`${BASE_URL}/api/v1/available-months`);
        console.log(`✓ Available months: ${months.data.available_months?.join(', ') || 'None'}`);
        console.log(`✓ Recommended: ${months.data.recommended_month}`);
        const recommendedMonth = months.data.recommended_month;
        passedTests++;

        /* 4. DGVI stats for recommended month
        if (recommendedMonth) {
            totalTests++;
            console.log(`\n4. Testing DGVI stats for ${recommendedMonth}...`);
            try {
                const dgviStats = await axios.get(`${BASE_URL}/api/v1/dgvi-stats/${recommendedMonth}`);
                console.log(`✓ Total GVI points: ${dgviStats.data.statistics?.total_gvi_points || 0}`);
                console.log(`✓ Average GVI: ${dgviStats.data.statistics?.avg_gvi?.toFixed(3) || 'N/A'}`);
                passedTests++;
            } catch (error) {
                console.log(`✗ DGVI stats failed: ${error.response?.data?.error || error.message}`);
            }
        }*/

        // 5. Nearby sites at Odenplan
        totalTests++;
        console.log('\n5. Testing nearby sites at Odenplan...');
        const sites = await axios.get(`${BASE_URL}/api/v1/nearby-sites`, {
            params: { 
                lat: LOCATIONS.odenplan.lat, 
                lon: LOCATIONS.odenplan.lon, 
                max_distance: 2000 
            }
        });
        console.log(`Found ${sites.data.sites_found} sites near Odenplan`);
        if (sites.data.sites?.length > 0) {
            console.log(`✓ First site: ${sites.data.sites[0].siteName} (${Math.round(sites.data.sites[0].walkingDistance)}m)`);
        }
        passedTests++;

        // 6. Route planning: Odenplan to KTH
        totalTests++;
        console.log('\n6. Testing route planning: Odenplan → KTH...');
        const routes = await axios.post(`${BASE_URL}/api/v1/plan-routes`, {
            origin: LOCATIONS.odengatan,
            destination: LOCATIONS.kth,
            preferences: { time: 0.5, green: 0.5 },
            gvi_month: recommendedMonth,
            max_results: 3
        });
        console.log(`✓ Generated ${routes.data.results.total_routes} routes`);
        
        if (routes.data.results.routes?.length > 0) {
            routes.data.results.routes.forEach((route, index) => {
                console.log(`  Route ${index + 1}: ${route.route_type} - ${Math.round(route.total_duration / 60)}min - Score: ${route.total_score?.toFixed(3) || 'N/A'}`);
            });
        }
        passedTests++;

        // 7. Alternative route test: Stockholm Center to KTH
        totalTests++;
        console.log('\n8. Testing alternative route: Stockholm Center → KTH...');
        try {
            const altRoutes = await axios.post(`${BASE_URL}/api/v1/plan-routes`, {
                origin: LOCATIONS.stockholm_center,
                destination: LOCATIONS.kth,
                preferences: { time: 0.3, green: 0.7 }, // Green-focused
                gvi_month: recommendedMonth,
                max_results: 2
            });
            console.log(`✓ Generated ${altRoutes.data.results.total_routes} green-focused routes`);
            passedTests++;
        } catch (error) {
            console.log(`✗ Alternative route failed: ${error.response?.data?.error || error.message}`);
        }

        // Summary
        console.log('\n' + '='.repeat(50));
        console.log(`TEST SUMMARY: ${passedTests}/${totalTests} tests passed`);
        console.log(`Success rate: ${Math.round((passedTests / totalTests) * 100)}%`);
        
        if (passedTests === totalTests) {
            console.log('All tests passed! API is working correctly.');
        } else {
            console.log('Some tests failed. Check the errors above.');
        }

    } catch (error) {
        console.error('\nCritical test failure:', error.response?.data || error.message);
        if (error.response?.status) {
            console.error(`HTTP Status: ${error.response.status}`);
        }
        if (error.code === 'ECONNREFUSED') {
            console.error('Is the server running on port 8080?');
        }
    }
}

if (require.main === module) {
    testAPI();
}

module.exports = testAPI;