import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

const COLORS = {
  ocean950: '#17150f',
  ocean300: '#746f61',
  ocean200: '#48443a',
  ocean50: '#14130f',
  warmWhite: '#f8f1e3',
  coral: '#ff493d',
  coralSoft: '#ff7557',
  orange: '#e78a2f',
  orangeSoft: '#f0a24a',
  cyan: '#91cfdd',
  cyanDeep: '#5aa8bb',
  olive: '#b5bb7e',
  oliveDeep: '#8b9158',
  mist: 'rgba(255, 255, 245, 0.62)',
  mistBorder: 'rgba(23, 21, 15, 0.14)',
  ink: '#14130f',
};

function IconTile({ name, colors }) {
  return (
    <LinearGradient
      colors={colors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.iconTile}
    >
      <Ionicons name={name} size={20} color={COLORS.warmWhite} />
    </LinearGradient>
  );
}

function Node({ icon, colors, title, subtitle }) {
  return (
    <View style={styles.node}>
      <IconTile name={icon} colors={colors} />
      <Text style={styles.nodeTitle}>{title}</Text>
      {subtitle ? <Text style={styles.nodeSub}>{subtitle}</Text> : null}
    </View>
  );
}

function ArrowRight({ label }) {
  return (
    <View style={styles.hArrow}>
      {label ? (
        <Text style={styles.arrowLabel} numberOfLines={2}>
          {label}
        </Text>
      ) : null}
      <View style={styles.hArrowLineRow}>
        <LinearGradient
          colors={['rgba(23, 21, 15, 0.08)', 'rgba(255, 73, 61, 0.55)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.hLine}
        />
        <View style={styles.arrowHeadRight} />
      </View>
    </View>
  );
}

function ArrowDown({ label }) {
  return (
    <View style={styles.vArrow}>
      <LinearGradient
        colors={['rgba(23, 21, 15, 0.08)', 'rgba(116, 111, 97, 0.55)']}
        style={styles.vLine}
      />
      <View style={styles.arrowHeadDown} />
      {label ? <Text style={styles.arrowLabel}>{label}</Text> : null}
    </View>
  );
}

function Region({ title, glow, children, sideLabel, fill }) {
  return (
    <View style={[styles.region, { backgroundColor: fill, borderColor: glow }]}>
      <View style={styles.regionHeader}>
        <View style={[styles.regionDot, { backgroundColor: glow }]} />
        <Text style={styles.regionTitle}>{title}</Text>
      </View>
      {children}
      {sideLabel ? <Text style={styles.sideLabel}>{sideLabel}</Text> : null}
    </View>
  );
}

function FadeSlide({ value, children, style }) {
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: value,
          transform: [
            {
              translateY: value.interpolate({
                inputRange: [0, 1],
                outputRange: [22, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

export default function ArchitectureGraph({ visible = true }) {
  const header = useRef(new Animated.Value(0)).current;
  const colA = useRef(new Animated.Value(0)).current;
  const colB = useRef(new Animated.Value(0)).current;
  const colC = useRef(new Animated.Value(0)).current;
  const arrows = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      header.setValue(0);
      colA.setValue(0);
      colB.setValue(0);
      colC.setValue(0);
      arrows.setValue(0);
      return;
    }

    header.setValue(0);
    colA.setValue(0);
    colB.setValue(0);
    colC.setValue(0);
    arrows.setValue(0);

    Animated.sequence([
      Animated.timing(header, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }),
      Animated.stagger(110, [
        Animated.spring(colA, {
          toValue: 1,
          friction: 6,
          tension: 58,
          useNativeDriver: true,
        }),
        Animated.spring(colB, {
          toValue: 1,
          friction: 6,
          tension: 58,
          useNativeDriver: true,
        }),
        Animated.spring(colC, {
          toValue: 1,
          friction: 6,
          tension: 58,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(arrows, {
        toValue: 1,
        duration: 340,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, header, colA, colB, colC, arrows]);

  return (
    <View style={styles.canvas}>
      <FadeSlide value={header}>
        <Text style={styles.kicker}>ARCHITECTURE</Text>
        <Text style={styles.captionTop}>
          Local laptop vision, xAI voice control, and optional Snowflake event
          intelligence.
        </Text>
      </FadeSlide>

      <View style={styles.flowRow}>
        <FadeSlide value={colA}>
          <Region title="Wearer & devices" glow={COLORS.coral} fill={COLORS.mist}>
            <Node
              icon="glasses-outline"
              colors={[COLORS.coralSoft, COLORS.coral]}
              title="Smart glasses"
              subtitle="periodic JPEG photo bursts"
            />
            <View style={styles.stackGap} />
            <Node
              icon="phone-portrait-outline"
              colors={['#2d2a20', COLORS.ocean950]}
              title="Phone app"
              subtitle="push-to-talk, places & speech"
            />
            <View style={styles.stackGap} />
            <Node
              icon="person-outline"
              colors={[COLORS.olive, COLORS.oliveDeep]}
              title="Wearer"
              subtitle="accessible private control"
            />
          </Region>
        </FadeSlide>

        <Animated.View style={[styles.midArrows, { opacity: arrows }]}>
          <ArrowRight label="BLE JPEG bursts" />
          <View style={styles.midArrowSpacer} />
          <ArrowRight label="GPS, app tools & cues" />
          <View style={styles.midArrowSpacer} />
          <View style={styles.returnArrow}>
            <View style={styles.arrowHeadLeft} />
            <LinearGradient
              colors={['rgba(255, 73, 61, 0.55)', 'rgba(23, 21, 15, 0.08)']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.hLine}
            />
            <Text style={styles.arrowLabel}>spoken guidance</Text>
          </View>
        </Animated.View>

        <FadeSlide value={colB}>
          <Region
            title="Local laptop vision"
            glow={COLORS.oliveDeep}
            fill={COLORS.mist}
            sideLabel="Camera photos stop at the paired laptop"
          >
            <View style={styles.centerNode}>
              <Node
                icon="laptop-outline"
                colors={['#494537', COLORS.ocean950]}
                title="Vision pipeline"
                subtitle="BLE ingest and orchestration"
              />
            </View>
            <View style={styles.splitArrows}>
              <ArrowDown label="detect" />
              <ArrowDown label="recognize" />
            </View>
            <View style={styles.splitRow}>
              <Node
                icon="scan-outline"
                colors={[COLORS.olive, COLORS.oliveDeep]}
                title="YOLO"
                subtitle="objects, distance & bearing"
              />
              <Node
                icon="person-circle-outline"
                colors={[COLORS.orangeSoft, COLORS.orange]}
                title="InsightFace"
                subtitle="local known-person matching"
              />
            </View>
          </Region>
        </FadeSlide>

        <Animated.View style={[styles.midArrows, { opacity: arrows }]}>
          <ArrowRight label="structured metadata" />
          <Text style={styles.noImages}>no camera photos</Text>
        </Animated.View>

        <FadeSlide value={colC}>
          <Region
            title="Cloud services"
            glow={COLORS.cyanDeep}
            fill={COLORS.mist}
            sideLabel="No camera photos enter the cloud"
          >
            <View style={styles.splitRow}>
              <Node
                icon="sparkles-outline"
                colors={[COLORS.cyan, COLORS.cyanDeep]}
                title="xAI assistant"
                subtitle="transcription & app tools"
              />
              <Node
                icon="server-outline"
                colors={['#494537', COLORS.ocean950]}
                title="Snowflake Cortex"
                subtitle="narration & event history"
              />
            </View>
            <View style={styles.splitArrows}>
              <ArrowDown label="select" />
              <ArrowDown label="analyze" />
            </View>
            <View style={styles.splitRow}>
              <Node
                icon="construct-outline"
                colors={[COLORS.cyanDeep, '#3d8a9c']}
                title="App tools"
                subtitle="confirmed phone actions"
              />
              <Node
                icon="shield-checkmark-outline"
                colors={[COLORS.coralSoft, COLORS.coral]}
                title="Safety alerts"
                subtitle="unusual activity only"
              />
            </View>
          </Region>
        </FadeSlide>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    paddingRight: 16,
  },
  kicker: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.6,
    color: COLORS.ocean300,
    marginBottom: 4,
  },
  captionTop: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.ocean200,
    marginBottom: 16,
    maxWidth: 420,
  },
  flowRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  region: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 14,
  },
  regionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  regionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  regionTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    color: COLORS.ocean50,
    letterSpacing: 0.3,
    flexShrink: 1,
  },
  sideLabel: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 10,
    fontStyle: 'italic',
    color: COLORS.ocean300,
    marginTop: 12,
    textAlign: 'center',
  },
  node: {
    alignItems: 'center',
    width: 132,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 16,
    backgroundColor: COLORS.mist,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
  },
  iconTile: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 7,
  },
  nodeTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    color: COLORS.ink,
    textAlign: 'center',
  },
  nodeSub: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 10,
    color: COLORS.ocean200,
    textAlign: 'center',
    marginTop: 2,
    lineHeight: 13,
  },
  stackGap: {
    height: 10,
  },
  centerNode: {
    alignItems: 'center',
  },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  splitArrows: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: 6,
  },
  midArrows: {
    width: 86,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: 70,
  },
  midArrowSpacer: {
    height: 58,
  },
  hArrow: {
    width: 80,
    alignItems: 'center',
  },
  hArrowLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
  },
  hLine: {
    flex: 1,
    height: 2,
    borderRadius: 2,
  },
  vArrow: {
    alignItems: 'center',
    width: 70,
    paddingVertical: 2,
  },
  vLine: {
    width: 2,
    height: 16,
    borderRadius: 2,
  },
  arrowHeadRight: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: COLORS.coral,
  },
  arrowHeadLeft: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderRightWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: COLORS.coral,
  },
  arrowHeadDown: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: COLORS.ocean300,
  },
  arrowLabel: {
    fontFamily: 'Outfit_500Medium',
    fontSize: 9,
    color: COLORS.ocean300,
    textAlign: 'center',
    marginBottom: 3,
  },
  returnArrow: {
    width: 80,
    alignItems: 'center',
  },
  noImages: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 9,
    fontStyle: 'italic',
    color: COLORS.ocean300,
    marginTop: 8,
    textAlign: 'center',
  },
});
