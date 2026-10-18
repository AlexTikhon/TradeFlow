import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Box, Card, CardContent, Skeleton, Stack, Typography } from '@mui/material';
import type { TradeString, TradeStringParty, VoyageDetail } from '@tradeflow/contracts';
import { useIdentity } from '../../../shared/auth/identity';
import { formatCountry } from '../../../shared/lib/format';
import { QueryErrorAlert } from '../../../shared/ui/QueryErrorAlert';
import { participantRoleLabel } from '../domain/participant-role';
import { tradeStringSteps } from '../domain/trade-string';
import { TradeStringSetup } from './TradeStringSetup';

/** Read by screen readers, not shown. (Pixel strings: in `sx`, a width of 1 means 100%.) */
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

/** Width of the gap between parties on wide screens, which holds the arrow and its label. */
const CONNECTOR_SPACING = 11;

function Party({ party, isOwn }: { party: TradeStringParty; isOwn: boolean }) {
  return (
    <Box
      sx={{
        height: '100%',
        p: 1.5,
        border: 1,
        borderColor: isOwn ? 'primary.main' : 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
      }}
    >
      <Typography variant="overline" component="p" color="text.secondary" sx={{ lineHeight: 1.6 }}>
        {participantRoleLabel(party.role)}
      </Typography>
      <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {party.organization.name}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {formatCountry(party.organization.countryCode)}
      </Typography>
      {isOwn && (
        <Typography variant="caption" component="p" color="primary" sx={{ fontWeight: 600 }}>
          Your organization
        </Typography>
      )}
    </Box>
  );
}

/** The sale from one party to the next: below it on phones, in the gap beside it on wider screens. */
function Sale({ position, buyer }: { position: number; buyer: TradeStringParty }) {
  return (
    <Box
      sx={(theme) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        color: 'text.secondary',
        py: 1,
        pl: 2,
        [theme.breakpoints.up('md')]: {
          position: 'absolute',
          top: '50%',
          left: '100%',
          width: theme.spacing(CONNECTOR_SPACING),
          transform: 'translateY(-50%)',
          flexDirection: 'column',
          gap: 0.5,
          p: 0,
          textAlign: 'center',
        },
      })}
    >
      <ArrowForwardIcon fontSize="small" sx={{ transform: { xs: 'rotate(90deg)', md: 'none' } }} />
      <Typography variant="caption">
        <Box component="span" sx={visuallyHidden}>
          Sells to {buyer.organization.name} under{' '}
        </Box>
        Contract {position}
      </Typography>
    </Box>
  );
}

function TradeStringChain({ tradeString }: { tradeString: TradeString }) {
  const identity = useIdentity();
  const steps = tradeStringSteps(tradeString);

  if (steps.length === 0) {
    return (
      <Box sx={{ p: 2, border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 1 }}>
        <Typography sx={{ fontWeight: 600 }}>Trade string not configured</Typography>
        <Typography variant="body2" color="text.secondary">
          No sale contracts have been recorded for this voyage yet. Once they are, each sale from
          the exporter to the final buyer appears here, in contract order.
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      component="ol"
      // Explicit role: Safari drops list semantics from lists styled without markers.
      role="list"
      aria-label="Trade string, from exporter to final buyer"
      sx={{
        listStyle: 'none',
        m: 0,
        p: 0,
        display: { xs: 'flex', md: 'grid' },
        flexDirection: 'column',
        gridTemplateColumns: { md: `repeat(${steps.length}, minmax(0, 1fr))` },
        columnGap: { md: CONNECTOR_SPACING },
      }}
    >
      {steps.map(({ party, sale }) => (
        <Box component="li" key={party.organization.id} sx={{ position: 'relative', minWidth: 0 }}>
          <Party party={party} isOwn={party.organization.id === identity.organization.id} />
          {sale && <Sale position={sale.position} buyer={sale.buyer} />}
        </Box>
      ))}
    </Box>
  );
}

interface TradeStringCardProps {
  voyage: VoyageDetail;
  tradeString: TradeString | undefined;
  error: Error | null;
  onRetry: () => void;
}

export function TradeStringCard({ voyage, tradeString, error, onRetry }: TradeStringCardProps) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h2" sx={{ mb: 0.5 }}>
          Trade string
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Who sells the cargo to whom. Every participant sees these parties; contract terms are not
          shared here.
        </Typography>
        {error ? (
          <QueryErrorAlert
            title="Trade string could not be loaded"
            error={error}
            onRetry={onRetry}
          />
        ) : tradeString ? (
          <Stack spacing={2}>
            <TradeStringChain tradeString={tradeString} />
            <TradeStringSetup voyage={voyage} tradeString={tradeString} />
          </Stack>
        ) : (
          <Stack spacing={1} aria-busy aria-label="Loading trade string">
            <Skeleton variant="rounded" height={88} />
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
