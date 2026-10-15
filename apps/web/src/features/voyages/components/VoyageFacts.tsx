import { Box, Card, CardContent, Typography } from '@mui/material';
import type { Port, VoyageDetail } from '@tradeflow/contracts';
import type { ReactNode } from 'react';
import { formatCountry, formatLaycan, formatQuantity } from '../../../shared/lib/format';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography component="dt" variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" sx={{ m: 0, fontWeight: 500 }}>
        {children}
      </Typography>
    </div>
  );
}

const portLabel = (port: Port) =>
  `${port.name}, ${formatCountry(port.countryCode)} (${port.unLocode})`;

export function VoyageFacts({ voyage }: { voyage: VoyageDetail }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h2" sx={{ mb: 2 }}>
          Shipment
        </Typography>
        <Box
          component="dl"
          sx={{
            m: 0,
            display: 'grid',
            gap: 3,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
          }}
        >
          <Fact label="Vessel">
            {voyage.vessel.name}{' '}
            <Typography component="span" variant="body2" color="text.secondary">
              IMO {voyage.vessel.imoNumber}
            </Typography>
          </Fact>
          <Fact label="Commodity">{voyage.commodity.name}</Fact>
          <Fact label="Quantity">{formatQuantity(voyage.quantity)}</Fact>
          <Fact label="Origin">{portLabel(voyage.loadPort)}</Fact>
          <Fact label="Destination">{portLabel(voyage.dischargePort)}</Fact>
          <Fact label="Laycan">{formatLaycan(voyage.laycan)}</Fact>
        </Box>
      </CardContent>
    </Card>
  );
}
