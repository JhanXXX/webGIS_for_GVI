## Note on Model Files
For security and size considerations, the trained `.pth` model file is not included in this repository.  
Please contact the author if you need access to the model or wish to reproduce the results.



## An Urban Green View Spatial Database & Green Path Navigator
AOI: Only in stockholm
Author: Jinghan Xu [jinghanx@kth.se]
## project structure

```
project_bundle/
├── geoai/          # GVI (Sentinel-2 + pretrained CNN model)
├── backend/        # Node.js API 
├── frontend/       # React
├── database/       # PostgreSQL + PostGIS + PgRouting
└── DATA/           # Starting files
```

## Start

### Build up the containers
Enter the project root path
```bash
docker-compose up -build -d
```
### Initializing
Simply restore the database from .backup file stored under /DATA. Then jump to the functions
Otherwise, before any actions one needs to:
- Have a point shapefile to build up the GVI layer base
- Have a road network with valid PgRouting topology stored in the database

### Initialize SL bus sequences from random departure fetch
Enter the backend container
```bash
node /src/tools/data_builder.js sequences --sequence
```
Run whatever many times you like. The program updates automatically if any information is missing in the current records by any chance

### Add more monthly data from shapefile
Enter the geoai container
```bash
python /tests/ prepare_gvi_data.py YYYY-MM {path to your shapefile}
```
Feel free to interrupt the program. It automatically skips existed points of the same month.
The cache warning is ok. Either delete the cache option or mkdir what the program wants. I didnt' remove it because I was lazy.

## Information
### port

- **frontend**: http://localhost:3000
- **backend**: http://localhost:8080
- **GeoAI**: http://localhost:8000
- **database**: localhost:5432

### Check database configurations in the .yml file

### Logs are available to check at Docker 

### What is under /DATA
#### .backup for database
#### shp
- bus-sites
- bus-stop-points
Basically you can build them up by calling the SL api. But I sorted it by hand to narrow down the study area

- Stockholm_jr_samples
This is an example for GVI point shapefile. 

For the above two, make sure the CRS aligns with the current option.
